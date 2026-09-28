'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {loadHostingerGoogleEnv} = require('../portal/hostinger-env');
const {loadHostingerAppleEnv} = require('../portal/hostinger-env');
const root = '/home/u123456/domains/unfallx.com/hbuilds';
const fixture = 'GOOGLE_CLIENT_ID="fixture.apps.googleusercontent.com"\nGOOGLE_CLIENT_SECRET="fixture-secret"\nNODE_OPTIONS="--require untrusted.js"\nSMTP_PASS=do-not-load\n';

test('Hostinger current and resolved version paths load only the Google pair from private config', () => {
  for (const dir of [root + '/current/nodejs', root + '/versions/01abc-def/nodejs']) {
    const env = {SMTP_PASS:'existing-mail'};
    assert.equal(loadHostingerGoogleEnv(dir, env, (file, encoding) => {
      assert.equal(file, root + '/config/.env'); assert.equal(encoding, 'utf8'); return fixture;
    }), true);
    assert.deepEqual(env, {SMTP_PASS:'existing-mail', GOOGLE_CLIENT_ID:'fixture.apps.googleusercontent.com', GOOGLE_CLIENT_SECRET:'fixture-secret'});
  }
});
test('Local, test, other-domain and traversal paths never read hosting secrets', () => {
  let reads = 0;
  const read = () => { reads++; return fixture; };
  for (const dir of ['/tmp/nodejs', root + '/current/../nodejs', root.replace('unfallx.com','other.com') + '/current/nodejs', root + '/public_html']) {
    assert.equal(loadHostingerGoogleEnv(dir, {}, read), false);
  }
  assert.equal(loadHostingerGoogleEnv(root + '/current/nodejs', {NODE_ENV:'test'}, read), false);
  assert.equal(reads, 0);
});
test('Complete injected credentials take precedence without reading the file', () => {
  const env = {GOOGLE_CLIENT_ID:'injected', GOOGLE_CLIENT_SECRET:'injected-secret'};
  assert.equal(loadHostingerGoogleEnv(root + '/current/nodejs', env, () => assert.fail('Unexpected read')), false);
  assert.deepEqual(env, {GOOGLE_CLIENT_ID:'injected', GOOGLE_CLIENT_SECRET:'injected-secret'});
});
test('Partial credentials are completed only when they belong to the same client', () => {
  const env = {GOOGLE_CLIENT_ID:'fixture.apps.googleusercontent.com'};
  assert.equal(loadHostingerGoogleEnv(root + '/current/nodejs', env, () => fixture), true);
  assert.equal(env.GOOGLE_CLIENT_SECRET,'fixture-secret');
  const different = {GOOGLE_CLIENT_ID:'other-client'};
  assert.equal(loadHostingerGoogleEnv(root + '/current/nodejs', different, () => fixture), false);
  assert.deepEqual(different,{GOOGLE_CLIENT_ID:'other-client'});
});
test('Missing, inaccessible or incomplete config leaves the existing environment untouched', () => {
  for (const read of [() => { throw Error('private secret in error'); }, () => 'GOOGLE_CLIENT_ID=fixture', () => '']) {
    const env = {SMTP_PASS:'existing-mail'};
    assert.equal(loadHostingerGoogleEnv(root + '/current/nodejs', env, read), false);
    assert.deepEqual(env,{SMTP_PASS:'existing-mail'});
  }
});

test('Private Hostinger S3 config loads atomically without unrelated variables or mixed credentials',()=>{
 const {loadHostingerStorageEnv}=require('../portal/hostinger-env');
 const values={PORTAL_FILE_STORAGE:'s3',PORTAL_S3_BUCKET:'unfallx-fixture',PORTAL_S3_REGION:'eu-central-1',PORTAL_S3_ACCOUNT_ID:'123456789012',PORTAL_S3_ACCESS_KEY_ID:'fixture-key',PORTAL_S3_SECRET_ACCESS_KEY:'fixture-secret'};
 const content=Object.entries({...values,PORTAL_STORAGE_MB:'102400',NODE_OPTIONS:'untrusted',SMTP_PASS:'unrelated'}).map(([k,v])=>k+'='+v).join('\n');
 const dir=root+'/current/nodejs',read=()=>content,target={};
 assert.equal(loadHostingerStorageEnv(dir,target,read),true);
 assert.deepEqual(target,{...values,PORTAL_STORAGE_MB:'102400'});
 const conflict={PORTAL_S3_ACCESS_KEY_ID:'other-key'};
 assert.equal(loadHostingerStorageEnv(dir,conflict,read),false);assert.deepEqual(conflict,{PORTAL_S3_ACCESS_KEY_ID:'other-key'});
 assert.equal(loadHostingerStorageEnv('/tmp/app',{},()=>assert.fail('unexpected read')),false);
 assert.equal(loadHostingerStorageEnv(dir,{NODE_ENV:'test'},()=>assert.fail('unexpected read')),false);
 assert.equal(loadHostingerStorageEnv(dir,{},()=> 'PORTAL_FILE_STORAGE=s3'),false);
 const existingLimit={PORTAL_STORAGE_MB:'2048'};
 assert.equal(loadHostingerStorageEnv(dir,existingLimit,read),true);assert.equal(existingLimit.PORTAL_STORAGE_MB,'2048');
});

test('autoiXpert credentials only load as a consistent pair from the private hosting config',()=>{
 const {loadHostingerAutoixpertEnv}=require('../portal/hostinger-env'),dir='/home/u123/domains/unfallx.com/hbuilds/current/nodejs',fixture='AUTOIXPERT_API_KEY=test-secret\nAUTOIXPERT_ASSESSOR_ID=assessor\nUNRELATED=value',env={};
 assert.equal(loadHostingerAutoixpertEnv(dir,env,()=>fixture),true);assert.deepEqual(env,{AUTOIXPERT_API_KEY:'test-secret',AUTOIXPERT_ASSESSOR_ID:'assessor'});
 assert.equal(loadHostingerAutoixpertEnv('/tmp/app',{},()=>assert.fail('Unexpected read')),false);
 assert.equal(loadHostingerAutoixpertEnv(dir,{AUTOIXPERT_API_KEY:'other'},()=>fixture),false);
 assert.equal(loadHostingerAutoixpertEnv(dir,{},()=> 'AUTOIXPERT_API_KEY=test'),false);
});

const appleValues = {
  APPLE_CLIENT_ID: 'fixture.partner.login', APPLE_TEAM_ID: 'FIXTURE123',
  APPLE_KEY_ID: 'FIXTUREKEY', APPLE_PRIVATE_KEY: 'fixture-private-key',
  OAUTH_TOKEN_ENCRYPTION_KEY: 'ab'.repeat(32)
};
const appleConfig = Object.entries({...appleValues, GOOGLE_CLIENT_SECRET: 'do-not-load', NODE_OPTIONS: '--require untrusted.js'})
  .map(([key, value]) => key + '=' + value).join('\n');

test('Apple config loads all five allowlisted values from current and resolved Hostinger paths', () => {
  for (const dir of [root + '/current/nodejs', root + '/versions/01abc-def/nodejs']) {
    const env = {GOOGLE_CLIENT_SECRET: 'existing-google'};
    assert.equal(loadHostingerAppleEnv(dir, env, (file, encoding) => {
      assert.equal(file, root + '/config/.env'); assert.equal(encoding, 'utf8'); return appleConfig;
    }), true);
    assert.deepEqual(env, {...appleValues, GOOGLE_CLIENT_SECRET: 'existing-google'});
  }
});

test('Apple config never reads private files outside the intended production deployment', () => {
  const read = () => assert.fail('Unexpected private file read');
  for (const dir of ['/tmp/nodejs', root + '/current/../nodejs', root.replace('unfallx.com', 'other.com') + '/current/nodejs', root + '/public_html']) {
    assert.equal(loadHostingerAppleEnv(dir, {}, read), false);
  }
  assert.equal(loadHostingerAppleEnv(root + '/current/nodejs', {NODE_ENV: 'test'}, read), false);
  const injected = {...appleValues};
  assert.equal(loadHostingerAppleEnv(root + '/current/nodejs', injected, read), false);
  assert.deepEqual(injected, appleValues);
});

test('Apple partial configuration is completed only when every existing value agrees', () => {
  for (const key of Object.keys(appleValues)) {
    const matching = {[key]: appleValues[key]};
    assert.equal(loadHostingerAppleEnv(root + '/current/nodejs', matching, () => appleConfig), true);
    assert.deepEqual(matching, appleValues);
    const conflict = {[key]: 'different-existing-value'};
    assert.equal(loadHostingerAppleEnv(root + '/current/nodejs', conflict, () => appleConfig), false);
    assert.deepEqual(conflict, {[key]: 'different-existing-value'});
  }
});

test('Missing Apple values and invalid encryption keys leave the environment untouched', () => {
  for (const missing of Object.keys(appleValues)) {
    const incomplete = Object.entries(appleValues).filter(([key]) => key !== missing).map(([k, v]) => k + '=' + v).join('\n');
    const env = {GOOGLE_CLIENT_ID: 'existing-google'};
    assert.equal(loadHostingerAppleEnv(root + '/current/nodejs', env, () => incomplete), false);
    assert.deepEqual(env, {GOOGLE_CLIENT_ID: 'existing-google'});
  }
  for (const invalid of ['short', 'x'.repeat(64), 'ab'.repeat(31), 'ab'.repeat(33)]) {
    const env = {};
    assert.equal(loadHostingerAppleEnv(root + '/current/nodejs', env, () => appleConfig.replace(appleValues.OAUTH_TOKEN_ENCRYPTION_KEY, invalid)), false);
    assert.deepEqual(env, {});
  }
});

test('Apple private-file failures do not expose or modify configuration', () => {
  for (const read of [() => { throw Error('private-data-not-for-logs'); }, () => '']) {
    const env = {APPLE_CLIENT_ID: appleValues.APPLE_CLIENT_ID};
    assert.equal(loadHostingerAppleEnv(root + '/current/nodejs', env, read), false);
    assert.deepEqual(env, {APPLE_CLIENT_ID: appleValues.APPLE_CLIENT_ID});
  }
});

test('Imported Apple token encryption survives a process restart without key replacement', () => {
  const {tokenVault} = require('../portal/oauth-tokens');
  const env = {};
  assert.equal(loadHostingerAppleEnv(root + '/current/nodejs', env, () => appleConfig), true);
  const first = tokenVault(env);
  assert.equal(first.ready, true);
  const sealed = first.seal('fixture-refresh-token', 'fixture-identity');
  const restarted = {};
  assert.equal(loadHostingerAppleEnv(root + '/versions/next-release/nodejs', restarted, () => appleConfig), true);
  assert.equal(tokenVault(restarted).open(sealed, 'fixture-identity'), 'fixture-refresh-token');
  assert.throws(() => tokenVault(restarted).open(sealed, 'different-identity'));
});

test('APNs private config loads only a complete matching push key for the iPhone topic',()=>{
 const {loadHostingerPushEnv}=require('../portal/hostinger-env');
 const values={APNS_TEAM_ID:'TEAM123456',APNS_KEY_ID:'KEY1234567',APNS_PRIVATE_KEY:'test-only',APNS_TOPIC:'de.schadenakte.ios'},text=Object.entries({...values,APPLE_PRIVATE_KEY:'never-replace',NODE_OPTIONS:'never-load'}).map(([k,v])=>k+'='+v).join('\n'),dir=root+'/current/nodejs';
 const env={APPLE_PRIVATE_KEY:'existing'};assert.equal(loadHostingerPushEnv(dir,env,()=>text),true);assert.deepEqual(env,{...values,APPLE_PRIVATE_KEY:'existing'});
 for(const omit of Object.keys(values)){const incomplete=Object.entries(values).filter(([k])=>k!==omit).map(([k,v])=>k+'='+v).join('\n');assert.equal(loadHostingerPushEnv(dir,{},()=>incomplete),false);}
 assert.equal(loadHostingerPushEnv(dir,{},()=>text.replace('de.schadenakte.ios','wrong')),false);
 const conflict={APNS_KEY_ID:'OTHERKEY00'};assert.equal(loadHostingerPushEnv(dir,conflict,()=>text),false);assert.deepEqual(conflict,{APNS_KEY_ID:'OTHERKEY00'});
 for(const path of ['/tmp/app',root+'/current/../nodejs'])assert.equal(loadHostingerPushEnv(path,{},()=>assert.fail('Unexpected read')),false);
 assert.equal(loadHostingerPushEnv(dir,{NODE_ENV:'test'},()=>assert.fail('Unexpected read')),false);
});
