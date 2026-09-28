'use strict';
const fs = require('node:fs');
const {parseEnv} = require('node:util');

// Hostinger's shared Passenger subdomains do not always receive newly added
// hPanel variables. Read only the Google pair from the private hosting config.
// The file stays outside the web root; injected configuration takes precedence.
function loadHostingerGoogleEnv(appDir, env = process.env, read = fs.readFileSync) {
  if (env.NODE_ENV === 'test' || (env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET)) return false;
  const deployment = String(appDir).match(/^(\/home\/u\d+\/domains\/unfallx\.com\/hbuilds)\/(?:current|versions\/[a-zA-Z0-9-]+)\/nodejs$/);
  if (!deployment) return false;
  try {
    const values = parseEnv(read(deployment[1] + '/config/.env', 'utf8'));
    if (!values.GOOGLE_CLIENT_ID || !values.GOOGLE_CLIENT_SECRET) return false;
    const keys = ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET'];
    // Never accidentally combine credentials belonging to different clients.
    if (keys.some(key => env[key] && env[key] !== values[key])) return false;
    for (const key of keys) if (!env[key]) env[key] = values[key];
    return true;
  } catch {
    // A missing private config must not take password login or uploads offline.
    // Never log file contents, credentials or parser errors.
    return false;
  }
}

function loadHostingerStorageEnv(appDir, env = process.env, read = fs.readFileSync) {
  const keys=['PORTAL_FILE_STORAGE','PORTAL_S3_BUCKET','PORTAL_S3_REGION','PORTAL_S3_ACCOUNT_ID','PORTAL_S3_ACCESS_KEY_ID','PORTAL_S3_SECRET_ACCESS_KEY'];
  if(env.NODE_ENV==='test'||keys.every(key=>env[key]))return false;
  const deployment=String(appDir).match(/^(\/home\/u\d+\/domains\/unfallx\.com\/hbuilds)\/(?:current|versions\/[a-zA-Z0-9-]+)\/nodejs$/);
  if(!deployment)return false;
  try {
    const values=parseEnv(read(deployment[1]+'/config/.env','utf8'));
    if(!keys.every(key=>values[key])||keys.some(key=>env[key]&&env[key]!==values[key]))return false;
    for(const key of keys)if(!env[key])env[key]=values[key];
    if(!env.PORTAL_STORAGE_MB&&values.PORTAL_STORAGE_MB)env.PORTAL_STORAGE_MB=values.PORTAL_STORAGE_MB;
    return true;
  } catch {return false;}
}

function loadHostingerAutoixpertEnv(appDir, env = process.env, read = fs.readFileSync) {
  if (env.NODE_ENV === 'test' || (env.AUTOIXPERT_ASSESSOR_ID && env.AUTOIXPERT_API_KEY)) return false;
  const deployment = String(appDir).match(/^(\/home\/u\d+\/domains\/unfallx\.com\/hbuilds)\/(?:current|versions\/[a-zA-Z0-9-]+)\/nodejs$/);
  if (!deployment) return false;
  try {
    const values = parseEnv(read(deployment[1] + '/config/.env', 'utf8'));
    if (!values.AUTOIXPERT_ASSESSOR_ID || !values.AUTOIXPERT_API_KEY) return false;
    const keys = ['AUTOIXPERT_ASSESSOR_ID', 'AUTOIXPERT_API_KEY'];
    // Never accidentally combine credentials belonging to different clients.
    if (keys.some(key => env[key] && env[key] !== values[key])) return false;
    for (const key of keys) if (!env[key]) env[key] = values[key];
    return true;
  } catch {
    // A missing private config must not take password login or uploads offline.
    // Never log file contents, credentials or parser errors.
    return false;
  }
}

// Use the same private config for Passenger's app subdomain. Keep Apple and
// its token-encryption key together; never replace an already injected key.
function loadHostingerAppleEnv(appDir, env = process.env, read = fs.readFileSync) {
  const keys = ['APPLE_CLIENT_ID', 'APPLE_TEAM_ID', 'APPLE_KEY_ID', 'APPLE_PRIVATE_KEY', 'OAUTH_TOKEN_ENCRYPTION_KEY'];
  if (env.NODE_ENV === 'test' || keys.every(key => env[key])) return false;
  const deployment = String(appDir).match(/^(\/home\/u\d+\/domains\/unfallx\.com\/hbuilds)\/(?:current|versions\/[a-zA-Z0-9-]+)\/nodejs$/);
  if (!deployment) return false;
  try {
    const values = parseEnv(read(deployment[1] + '/config/.env', 'utf8'));
    if (!keys.every(key => values[key]) || !/^[a-f0-9]{64}$/i.test(values.OAUTH_TOKEN_ENCRYPTION_KEY)) return false;
    if (keys.some(key => env[key] && env[key] !== values[key])) return false;
    for (const key of keys) if (!env[key]) env[key] = values[key];
    return true;
  } catch {
    // No private values or parser errors in logs; other login methods remain available.
    return false;
  }
}

module.exports = {loadHostingerGoogleEnv,loadHostingerStorageEnv,loadHostingerAutoixpertEnv,loadHostingerAppleEnv};

function loadHostingerPushEnv(appDir, env = process.env, read = fs.readFileSync) {
 const keys=['APNS_TEAM_ID','APNS_KEY_ID','APNS_PRIVATE_KEY','APNS_TOPIC'];
 if(env.NODE_ENV==='test'||keys.every(k=>env[k]))return false;
 const deployment=String(appDir).match(/^(\/home\/u\d+\/domains\/unfallx\.com\/hbuilds)\/(?:current|versions\/[a-zA-Z0-9-]+)\/nodejs$/);
 if(!deployment)return false;
 try {const values=parseEnv(read(deployment[1]+'/config/.env','utf8'));
  if(!keys.every(k=>values[k])||values.APNS_TOPIC!=='de.schadenakte.ios'||keys.some(k=>env[k]&&env[k]!==values[k]))return false;
  for(const key of keys)if(!env[key])env[key]=values[key];return true;
 }catch{return false;}
}
module.exports.loadHostingerPushEnv=loadHostingerPushEnv;
