/** node:vm 浏览器 stub：nodevm 后端在浏览器不可用（wasm 后端承担一切） */
export function runInContext(): never {
  throw new Error('nodevm backend unavailable in browser — use wasm (quickjs) backend');
}
export default { runInContext };
