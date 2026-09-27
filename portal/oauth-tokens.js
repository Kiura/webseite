'use strict';
const crypto=require('node:crypto');
const {assert}=require('./domain');
// Separate deployment secret; never derive provider-token encryption from a public value.
function tokenVault(env){
 const raw=env.OAUTH_TOKEN_ENCRYPTION_KEY||'';
 const key=/^[a-f0-9]{64}$/i.test(raw)?Buffer.from(raw,'hex'):null;
 function seal(token,identityId){
  assert(key,'Apple-Anmeldung wird noch eingerichtet.',503);
  assert(typeof token==='string'&&token.length>0&&token.length<16000,'Anbieter-Token fehlt.',502);
  const iv=crypto.randomBytes(12),cipher=crypto.createCipheriv('aes-256-gcm',key,iv);
  cipher.setAAD(Buffer.from(identityId));
  const encrypted=Buffer.concat([cipher.update(token,'utf8'),cipher.final()]);
  return [iv.toString('base64url'),cipher.getAuthTag().toString('base64url'),encrypted.toString('base64url')].join('.');
 }
 function open(value,identityId){
  assert(key,'Apple-Token-Schlüssel fehlt.',503);
  try{const [iv,tag,bytes]=value.split('.').map(x=>Buffer.from(x,'base64url'));const decipher=crypto.createDecipheriv('aes-256-gcm',key,iv);decipher.setAAD(Buffer.from(identityId));decipher.setAuthTag(tag);return Buffer.concat([decipher.update(bytes),decipher.final()]).toString('utf8');}
  catch{assert(false,'Apple-Verknüpfung konnte nicht sicher gelesen werden.',503);}
 }
 return {ready:!!key,seal,open};
}
module.exports={tokenVault};
