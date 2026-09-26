'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {loadHostingerGoogleEnv} = require('../portal/hostinger-env');
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

test('0account credentials only load as a consistent pair; the issuer stays optional',()=>{
 const {loadHostingerZeroaccountEnv}=require('../portal/hostinger-env'),dir='/home/u123/domains/unfallx.com/hbuilds/current/nodejs';
 const fixture='ZEROACCOUNT_CLIENT_ID=client\nZEROACCOUNT_CLIENT_SECRET=test-secret\nZEROACCOUNT_ISSUER=https://v1.0account.com\nUNRELATED=value',env={};
 assert.equal(loadHostingerZeroaccountEnv(dir,env,()=>fixture),true);assert.deepEqual(env,{ZEROACCOUNT_CLIENT_ID:'client',ZEROACCOUNT_CLIENT_SECRET:'test-secret',ZEROACCOUNT_ISSUER:'https://v1.0account.com'});
 assert.equal(loadHostingerZeroaccountEnv('/tmp/app',{},()=>assert.fail('Unexpected read')),false);
 assert.equal(loadHostingerZeroaccountEnv(dir,{ZEROACCOUNT_CLIENT_ID:'other'},()=>fixture),false);
 assert.equal(loadHostingerZeroaccountEnv(dir,{},()=> 'ZEROACCOUNT_CLIENT_ID=client'),false);
 // Ohne Adresse bleibt die Produktionsadresse gültig, die Zugangsdaten laden trotzdem.
 const withoutIssuer={};
 assert.equal(loadHostingerZeroaccountEnv(dir,withoutIssuer,()=> 'ZEROACCOUNT_CLIENT_ID=client\nZEROACCOUNT_CLIENT_SECRET=test-secret'),true);
 assert.equal(withoutIssuer.ZEROACCOUNT_ISSUER,undefined);
});
