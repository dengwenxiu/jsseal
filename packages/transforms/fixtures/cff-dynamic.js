function getOrder() {
  return '2|0|1|3';
}
function work() {
  var out = '';
  var seq = getOrder().split('|'), i = 0;
  while (!![]) {
    switch (seq[i++]) {
      case '0':
        out += 'a';
        continue;
      case '1':
        out += 'c';
        continue;
      case '2':
        out += 'b';
        continue;
      case '3':
        out += 'd';
        continue;
    }
    break;
  }
  return out;
}
work();
