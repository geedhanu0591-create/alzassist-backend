const webpush = require('web-push');

const vapid = webpush.generateVAPIDKeys();
console.log("Your VAPID keys:");
console.log("Public Key:", vapid.publicKey);
console.log("Private Key:", vapid.privateKey);
