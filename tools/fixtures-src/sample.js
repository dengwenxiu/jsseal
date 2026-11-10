var key = "SECRET_KEY_123";

function encrypt(msg) {
  var out = '';
  for (var i = 0; i < msg.length; i++) {
    out += String.fromCharCode(msg.charCodeAt(i) ^ key.charCodeAt(i % key.length));
  }
  return out;
}

function decrypt(msg) {
  var out = '';
  for (var i = 0; i < msg.length; i++) {
    out += String.fromCharCode(msg.charCodeAt(i) ^ key.charCodeAt(i % key.length));
  }
  return out;
}

function main() {
  var enc = encrypt('hello world');
  console.log('encrypted:' + enc);
  console.log('decrypted:' + decrypt(enc));
  console.log('token:' + Math.random().toString(36).slice(2, 10));
  return 'done';
}

main();
