import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {ownedProcessGuard} from '../dist/execution.js';
const alive=pid=>{try{process.kill(pid,0);return true;}catch{return false;}};
const until=async fn=>{for(let i=0;i<100;i++){if(await fn())return;await delay(50);}throw Error('Process deadline');};
test('owner SIGKILL terminates guarded executable, even when it ignores SIGTERM',{timeout:8000},async t=>{
 const home=await mkdtemp(path.join(tmpdir(),'nc-owned-'));let guardPID,workerPID;
 const parent=spawn(process.execPath,['-e',`
 const {spawn}=require('node:child_process');const fs=require('node:fs');
 const child=spawn(process.execPath,['-e',${JSON.stringify(ownedProcessGuard)},process.execPath,'-e',${JSON.stringify(`require('node:fs').writeFileSync(${JSON.stringify(home+'/worker')},String(process.pid));process.on('SIGTERM',()=>{});setInterval(()=>{},1000);`)}],{detached:true,stdio:['ignore','ignore','ignore','pipe']});
 fs.writeFileSync(${JSON.stringify(home+'/guard')},String(child.pid));setInterval(()=>{},1000);
 `],{stdio:'ignore'});
 t.after(async()=>{parent.kill('SIGKILL');if(guardPID&&alive(guardPID))try{process.kill(-guardPID,'SIGKILL');}catch{}await rm(home,{recursive:true,force:true});});
 await until(async()=>{try{guardPID=Number(await readFile(home+'/guard'));workerPID=Number(await readFile(home+'/worker'));return true;}catch{return false;}});
 parent.kill('SIGKILL');await until(()=>!alive(guardPID)&&!alive(workerPID));
});
test('guard preserves stdin, stdout and successful executable exit',{timeout:5000},async t=>{
 const child=spawn(process.execPath,['-e',ownedProcessGuard,process.execPath,'-e',`let s='';process.stdin.on('data',c=>s+=c);process.stdin.on('end',()=>process.stdout.write(s));`],{detached:true,stdio:['pipe','pipe','ignore','pipe']});
 t.after(()=>{if(alive(child.pid))try{process.kill(-child.pid,'SIGKILL');}catch{}});
 let result='';child.stdout.on('data',c=>result+=c);const exited=new Promise(resolve=>child.once('exit',(code,signal)=>resolve({code,signal})));
 child.stdin.end('complete hook payload');assert.deepEqual(await exited,{code:0,signal:null});assert.equal(result,'complete hook payload');
});
