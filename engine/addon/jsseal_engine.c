/**
 * jsseal engine — native QuickJS (quickjs-ng fork) N-API addon
 *
 * 高层 API：sealedRun(options) → { dump, seedTapes?, seedConsumed?, seedExhausted?,
 *   gasUsed?, traceJson?, traceTruncated?, traceCount?, forceApplied? } 或 { fault, detail }
 *
 * C 侧编排：
 *   ctx 创建 → 种子模式/磁带 → prelude → [gas 限额 / 强制分支 / trace 开启]
 *   → 用户代码（完成值/异常挂全局）→ 虚拟事件循环（微任务⇄定时器，步数上限）
 *   → [trace/强制关闭] → captureTail → dumpExpr → 结果导出
 *
 * 注意（实测教训，勿重蹈）：
 *   - JS_SetPropertyStr consume 属性值引用，Set 后不得再 FreeValue（双重释放崩栈）
 *   - napi_get_named_property 前必须 typeof 检查（undefined 上取属性 = pending exception 泄漏）
 *   - gas/trace/force 只在用户代码窗口生效（prelude 与 dump 的开销/噪声不计）
 */

#define NAPI_VERSION 8
#include <node_api.h>
#include <stdbool.h>
#include <stdlib.h>
#include <time.h>
#include <string.h>
#include <stdio.h>

#include "quickjs.h"

#define JSSEAL_SEED_OFF 0
#define JSSEAL_SEED_RECORD 1
#define JSSEAL_SEED_REPLAY 2

#define JSSEAL_MAX_TIMER_STEPS 100000

/* ---------- 超时中断 ---------- */
typedef struct {
    int64_t deadline_ms;
} jsseal_interrupt_state;

static int jsseal_interrupt_handler(JSContext *ctx, void *opaque) {
    (void)ctx;
    jsseal_interrupt_state *st = (jsseal_interrupt_state *)opaque;
    if (st == NULL) return 0;
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    int64_t now_ms = (int64_t)ts.tv_sec * 1000 + ts.tv_nsec / 1000000;
    return now_ms > st->deadline_ms; /* 非 0 = 中断 */
}

/* ---------- 异常转字符串 ---------- */
static char *jsseal_exception_to_string(JSContext *ctx) {
    JSValue e = JS_GetException(ctx);
    const char *msg = JS_ToCString(ctx, e);
    char *out;
    if (msg) {
        out = strdup(msg);
        JS_FreeCString(ctx, msg);
    } else {
        out = strdup("(unserializable exception)");
    }
    JSValue e2 = JS_GetException(ctx);
    JS_FreeValue(ctx, e2);
    JS_FreeValue(ctx, e);
    return out;
}

static void jsseal_eval_ignoring_result(JSContext *ctx, const char *code, const char *filename) {
    JSValue r = JS_Eval(ctx, code, strlen(code), filename, JS_EVAL_TYPE_GLOBAL);
    if (JS_IsException(r)) {
        char *s = jsseal_exception_to_string(ctx);
        free(s);
    }
    JS_FreeValue(ctx, r);
}

/* ---------- N-API 帮助 ---------- */
static napi_value make_string(napi_env env, const char *s) {
    napi_value out;
    napi_create_string_utf8(env, s ? s : "", NAPI_AUTO_LENGTH, &out);
    return out;
}

static napi_value make_fault(napi_env env, const char *fault, const char *detail) {
    napi_value obj, f, d;
    napi_create_object(env, &obj);
    napi_create_string_utf8(env, fault, NAPI_AUTO_LENGTH, &f);
    napi_set_named_property(env, obj, "fault", f);
    if (detail) {
        napi_create_string_utf8(env, detail, NAPI_AUTO_LENGTH, &d);
        napi_set_named_property(env, obj, "detail", d);
    }
    return obj;
}

static napi_status get_str_prop(napi_env env, napi_value obj, const char *name, char **out) {
    napi_value v;
    napi_status st = napi_get_named_property(env, obj, name, &v);
    if (st != napi_ok) return st;
    size_t len = 0;
    st = napi_get_value_string_utf8(env, v, NULL, 0, &len);
    if (st != napi_ok) return st;
    *out = (char *)malloc(len + 1);
    return napi_get_value_string_utf8(env, v, *out, len + 1, &len);
}

static double get_num_prop(napi_env env, napi_value obj, const char *name, double dflt) {
    napi_value v;
    double d = dflt;
    if (napi_get_named_property(env, obj, name, &v) == napi_ok) {
        napi_get_value_double(env, v, &d);
    }
    return d;
}

static double *read_double_array(napi_env env, napi_value obj, const char *name, uint32_t *out_len) {
    napi_value arr;
    napi_valuetype t = napi_undefined;
    napi_get_named_property(env, obj, name, &arr);
    napi_typeof(env, arr, &t);
    if (t != napi_object || napi_get_array_length(env, arr, out_len) != napi_ok) {
        *out_len = 0;
        return NULL;
    }
    if (*out_len == 0) return NULL;
    double *vals = (double *)malloc(sizeof(double) * (*out_len));
    for (uint32_t i = 0; i < *out_len; i++) {
        napi_value el;
        napi_get_element(env, arr, i, &el);
        napi_get_value_double(env, el, &vals[i]);
    }
    return vals;
}

static napi_value make_double_array(napi_env env, const double *vals, uint32_t len) {
    napi_value arr;
    napi_create_array_with_length(env, len, &arr);
    for (uint32_t i = 0; i < len; i++) {
        napi_value v;
        napi_create_double(env, vals ? vals[i] : 0, &v);
        napi_set_element(env, arr, i, v);
    }
    return arr;
}

static void attach_seed_info(napi_env env, napi_value result, JSContext *ctx) {
    uint32_t len = 0;
    const double *vals;
    napi_value tapes_obj, consumed_obj, c;

    napi_create_object(env, &tapes_obj);
    vals = JS_GetSealSeedTape(ctx, "random", &len);
    napi_set_named_property(env, tapes_obj, "random", make_double_array(env, vals, len));
    vals = JS_GetSealSeedTape(ctx, "date", &len);
    napi_set_named_property(env, tapes_obj, "date", make_double_array(env, vals, len));
    vals = JS_GetSealSeedTape(ctx, "time", &len);
    napi_set_named_property(env, tapes_obj, "time", make_double_array(env, vals, len));
    vals = JS_GetSealSeedTape(ctx, "crypto", &len);
    napi_set_named_property(env, tapes_obj, "crypto", make_double_array(env, vals, len));
    napi_set_named_property(env, result, "seedTapes", tapes_obj);

    napi_create_object(env, &consumed_obj);
    napi_create_uint32(env, JS_GetSealSeedConsumed(ctx, "random"), &c);
    napi_set_named_property(env, consumed_obj, "random", c);
    napi_create_uint32(env, JS_GetSealSeedConsumed(ctx, "date"), &c);
    napi_set_named_property(env, consumed_obj, "date", c);
    napi_create_uint32(env, JS_GetSealSeedConsumed(ctx, "time"), &c);
    napi_set_named_property(env, consumed_obj, "time", c);
    napi_create_uint32(env, JS_GetSealSeedConsumed(ctx, "crypto"), &c);
    napi_set_named_property(env, consumed_obj, "crypto", c);
    napi_set_named_property(env, result, "seedConsumed", consumed_obj);

    napi_value ex;
    napi_get_boolean(env, JS_GetSealSeedExhausted(ctx) != 0, &ex);
    napi_set_named_property(env, result, "seedExhausted", ex);
}

/* ---------- 主入口 ---------- */
static napi_value SealedRun(napi_env env, napi_callback_info info) {
    size_t argc = 1;
    napi_value args[1];
    napi_get_cb_info(env, info, &argc, args, NULL, NULL);
    if (argc < 1) {
        napi_throw_error(env, NULL, "sealedRun expects an options object");
        return NULL;
    }
    napi_value opts = args[0];

    char *prelude = NULL, *code = NULL, *capture_tail = NULL, *dump_expr = NULL;
    if (get_str_prop(env, opts, "prelude", &prelude) != napi_ok || prelude == NULL ||
        get_str_prop(env, opts, "code", &code) != napi_ok || code == NULL) {
        free(prelude); free(code); free(capture_tail); free(dump_expr);
        napi_throw_error(env, NULL, "prelude and code are required strings");
        return NULL;
    }
    get_str_prop(env, opts, "captureTail", &capture_tail);
    get_str_prop(env, opts, "dumpExpr", &dump_expr);
    double memory_limit = get_num_prop(env, opts, "memoryLimit", 512.0 * 1024 * 1024);
    double timeout_ms = get_num_prop(env, opts, "timeoutMs", 10000);

    char *seed_mode = NULL;
    get_str_prop(env, opts, "seedMode", &seed_mode);
    double gas_limit = get_num_prop(env, opts, "gasLimit", 0);
    double force_branch_index = get_num_prop(env, opts, "forceBranchIndex", 0);

    double *tape_random = NULL, *tape_date = NULL, *tape_time = NULL, *tape_crypto = NULL;
    uint32_t tape_random_len = 0, tape_date_len = 0, tape_time_len = 0, tape_crypto_len = 0;
    {
        napi_value tapes;
        napi_valuetype tapes_type = napi_undefined;
        napi_get_named_property(env, opts, "seedTapes", &tapes);
        napi_typeof(env, tapes, &tapes_type);
        if (tapes_type == napi_object) {
            tape_random = read_double_array(env, tapes, "random", &tape_random_len);
            tape_date = read_double_array(env, tapes, "date", &tape_date_len);
            tape_time = read_double_array(env, tapes, "time", &tape_time_len);
            tape_crypto = read_double_array(env, tapes, "crypto", &tape_crypto_len);
        }
    }

    int trace_flags = 0;
    char *cret_fns[8] = {0};
    int cret_fns_n = 0;
    {
        napi_value tr;
        napi_valuetype tr_type = napi_undefined;
        napi_get_named_property(env, opts, "trace", &tr);
        napi_typeof(env, tr, &tr_type);
        if (tr_type == napi_object) {
            bool b = false;
            napi_value f;
            if (napi_get_named_property(env, tr, "calls", &f) == napi_ok &&
                napi_get_value_bool(env, f, &b) == napi_ok && b)
                trace_flags |= 1;
            b = false;
            if (napi_get_named_property(env, tr, "stringReturns", &f) == napi_ok &&
                napi_get_value_bool(env, f, &b) == napi_ok && b)
                trace_flags |= 2;
            b = false;
            if (napi_get_named_property(env, tr, "callArgs", &f) == napi_ok &&
                napi_get_value_bool(env, f, &b) == napi_ok && b)
                trace_flags |= 4;
            b = false;
            if (napi_get_named_property(env, tr, "branches", &f) == napi_ok &&
                napi_get_value_bool(env, f, &b) == napi_ok && b)
                trace_flags |= 8;
            /* cret 白名单 */
            napi_value fns;
            napi_valuetype fns_type = napi_undefined;
            napi_get_named_property(env, tr, "cretFns", &fns);
            napi_typeof(env, fns, &fns_type);
            if (fns_type == napi_object) {
                uint32_t alen = 0;
                if (napi_get_array_length(env, fns, &alen) == napi_ok) {
                    for (uint32_t i = 0; i < alen && cret_fns_n < 8; i++) {
                        napi_value el;
                        cret_fns[cret_fns_n] = NULL;
                        if (napi_get_element(env, fns, i, &el) == napi_ok) {
                            size_t l = 0;
                            if (napi_get_value_string_utf8(env, el, NULL, 0, &l) == napi_ok) {
                                cret_fns[cret_fns_n] = (char *)malloc(l + 1);
                                napi_get_value_string_utf8(env, el, cret_fns[cret_fns_n], l + 1, &l);
                                cret_fns_n++;
                            }
                        }
                    }
                }
            }
        }
    }

    JSRuntime *rt = JS_NewRuntime();
    if (rt == NULL) {
        free(prelude); free(code); free(capture_tail); free(dump_expr);
        free(seed_mode);
        free(tape_random); free(tape_date); free(tape_time); free(tape_crypto);
        for (int i = 0; i < cret_fns_n; i++) free(cret_fns[i]);
        napi_throw_error(env, NULL, "JS_NewRuntime failed");
        return NULL;
    }
    JS_SetMemoryLimit(rt, (size_t)memory_limit);
    jsseal_interrupt_state ist = {0};
    {
        struct timespec ts;
        clock_gettime(CLOCK_MONOTONIC, &ts);
        ist.deadline_ms = (int64_t)ts.tv_sec * 1000 + ts.tv_nsec / 1000000 + (int64_t)timeout_ms;
    }
    JS_SetInterruptHandler(rt, jsseal_interrupt_handler, &ist);

    JSContext *ctx = JS_NewContext(rt);
    JS_AddPerformance(ctx);
    JS_AddSealCrypto(ctx);

    if (seed_mode) {
        if (strcmp(seed_mode, "record") == 0)
            JS_SetSealSeedMode(ctx, JSSEAL_SEED_RECORD);
        else if (strcmp(seed_mode, "replay") == 0)
            JS_SetSealSeedMode(ctx, JSSEAL_SEED_REPLAY);
        else
            JS_SetSealSeedMode(ctx, JSSEAL_SEED_OFF);
        if (tape_random) JS_SetSealSeedTape(ctx, "random", tape_random, tape_random_len);
        if (tape_date) JS_SetSealSeedTape(ctx, "date", tape_date, tape_date_len);
        if (tape_time) JS_SetSealSeedTape(ctx, "time", tape_time, tape_time_len);
        if (tape_crypto) JS_SetSealSeedTape(ctx, "crypto", tape_crypto, tape_crypto_len);
    }

    napi_value result = NULL;

    /* 1) prelude */
    JSValue r0 = JS_Eval(ctx, prelude, strlen(prelude), "jsseal-prelude.js", JS_EVAL_TYPE_GLOBAL);
    if (JS_IsException(r0)) {
        char *d = jsseal_exception_to_string(ctx);
        result = make_fault(env, "prelude-error", d);
        free(d);
        goto done;
    }
    JS_FreeValue(ctx, r0);

    /* 用户代码窗口：gas 限额（prelude 开销不计）/ 强制分支 / trace */
    if (gas_limit > 0)
        JS_SetGasLimit(ctx, (uint64_t)gas_limit);
    if (force_branch_index > 0)
        JS_SetForceBranch(ctx, (int)force_branch_index);
    if (trace_flags)
        JS_SetTraceEnabled(ctx, trace_flags);
    if (cret_fns_n > 0) {
        const char *names[8];
        for (int i = 0; i < cret_fns_n; i++)
            names[i] = cret_fns[i];
        JS_SetTraceCretFnFilter(ctx, names, cret_fns_n);
    }

    /* 2) 用户代码：完成值/异常挂全局（SetPropertyStr consume 引用，勿重复释放） */
    {
        JSValue r1 = JS_Eval(ctx, code, strlen(code), "input.js", JS_EVAL_TYPE_GLOBAL);
        if (JS_IsException(r1)) {
            JSValue e = JS_GetException(ctx);
            JSValue global = JS_GetGlobalObject(ctx);
            JS_SetPropertyStr(ctx, global, "__jsseal_err", e);
            JS_FreeValue(ctx, global);
        } else {
            JSValue global = JS_GetGlobalObject(ctx);
            JS_SetPropertyStr(ctx, global, "__jsseal_last", r1);
            JS_FreeValue(ctx, global);
        }
    }

    /* 3) 虚拟事件循环：微任务 ⇄ 到期定时器（确定性，步数上限哨兵） */
    {
        int limit_hit = 0;
        for (int step = 0; step < JSSEAL_MAX_TIMER_STEPS; step++) {
            for (;;) {
                JSContext *c2;
                int err = JS_ExecutePendingJob(rt, &c2);
                if (err <= 0) break;
            }
            JSValue mr = JS_Eval(ctx,
                "String(globalThis.__jsseal && globalThis.__jsseal.runNextTimer"
                " ? globalThis.__jsseal.runNextTimer() : false)",
                96, "jsseal-timers.js", JS_EVAL_TYPE_GLOBAL);
            if (JS_IsException(mr)) {
                JS_FreeValue(ctx, JS_GetException(ctx));
                break;
            }
            const char *more = JS_ToCString(ctx, mr);
            int more_i = (more && more[0] == 't');
            JS_FreeCString(ctx, more);
            JS_FreeValue(ctx, mr);
            if (!more_i)
                break;
            if (step == JSSEAL_MAX_TIMER_STEPS - 1)
                limit_hit = 1;
        }
        if (limit_hit)
            jsseal_eval_ignoring_result(ctx,
                "globalThis.__jsseal.flags.timerDropped = true", "jsseal-timer-flag.js");
    }

    /* 窗口关闭：trace/强制不覆盖 captureTail 与 dump */
    JS_SetTraceEnabled(ctx, 0);
    JS_SetForceBranch(ctx, 0);

    /* 4) captureTail */
    if (capture_tail)
        jsseal_eval_ignoring_result(ctx, capture_tail, "jsseal-capture.js");

    /* 5) dump + 结果导出 */
    {
        const char *dump_code = dump_expr
            ? dump_expr
            : "JSON.stringify(globalThis.__jsseal && globalThis.__jsseal.dump ? globalThis.__jsseal.dump() : null)";
        JSValue rd = JS_Eval(ctx, dump_code, strlen(dump_code), "jsseal-dump.js", JS_EVAL_TYPE_GLOBAL);
        if (JS_IsException(rd)) {
            char *d = jsseal_exception_to_string(ctx);
            result = make_fault(env, "dump-error", d);
            free(d);
        } else {
            const char *s = JS_ToCString(ctx, rd);
            napi_create_object(env, &result);
            napi_value dv = make_string(env, s ? s : "null");
            napi_set_named_property(env, result, "dump", dv);
            JS_FreeCString(ctx, s);

            attach_seed_info(env, result, ctx);

            napi_value g, ge;
            napi_create_double(env, (double)JS_GetGasUsed(ctx), &g);
            napi_set_named_property(env, result, "gasUsed", g);
            napi_get_boolean(env, false, &ge); /* gas 超限由 TS 侧从 thrown 识别 */
            napi_set_named_property(env, result, "gasExhausted", ge);

            napi_value fa;
            napi_get_boolean(env, JS_GetForceBranchApplied(ctx) != 0, &fa);
            napi_set_named_property(env, result, "forceApplied", fa);

            size_t tlen = 0;
            int ttrunc = 0;
            uint32_t tcount = 0;
            char *tjson = JS_GetTraceJSON(ctx, &tlen, &ttrunc, &tcount);
            napi_value tv = make_string(env, tjson ? tjson : "[]");
            napi_set_named_property(env, result, "traceJson", tv);
            napi_value tt, tc;
            napi_get_boolean(env, ttrunc != 0, &tt);
            napi_set_named_property(env, result, "traceTruncated", tt);
            napi_create_uint32(env, tcount, &tc);
            napi_set_named_property(env, result, "traceCount", tc);
            js_free(ctx, tjson);
        }
        JS_FreeValue(ctx, rd);
    }

done:
    JS_FreeContext(ctx);
    JS_FreeRuntime(rt);
    free(prelude); free(code); free(capture_tail); free(dump_expr);
    free(seed_mode);
    free(tape_random); free(tape_date); free(tape_time); free(tape_crypto);
    for (int i = 0; i < cret_fns_n; i++) free(cret_fns[i]);
    return result;
}

/* ---------- 模块注册 ---------- */
static napi_value Init(napi_env env, napi_value exports) {
    napi_value fn;
    napi_create_function(env, "sealedRun", NAPI_AUTO_LENGTH, SealedRun, NULL, &fn);
    napi_set_named_property(env, exports, "sealedRun", fn);
    napi_value ver;
    napi_create_string_utf8(env, "quickjs-ng fork (jsseal) 0.2.0", NAPI_AUTO_LENGTH, &ver);
    napi_set_named_property(env, exports, "engineVersion", ver);
    return exports;
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)
