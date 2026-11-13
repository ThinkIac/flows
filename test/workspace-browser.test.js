import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { build } from 'esbuild';
import { compile } from 'svelte/compiler';
import puppeteer from 'puppeteer';

test('transparent editor: panels, triggers, connections, save failure, reopen and mobile', { timeout: 90000 }, async () => {
  const result = await build({ stdin: { contents: `import Editor from './packages/flows/views/Editor.svelte'; new Editor({target:document.body,props:{documentRole:new URLSearchParams(location.search).get('widgetRole')}});`, resolveDir: process.cwd() }, bundle:true, write:false, format:'iife', conditions:['browser'], plugins:[{name:'svelte',setup(b){ b.onLoad({filter:/\.svelte$/},async ({path:p})=>({contents:compile(await fs.readFile(p,'utf8'),{filename:p,css:'injected',generate:'dom'}).js.code,resolveDir:path.dirname(p)})); }}] });
  const bundle = result.outputFiles[0].text;
  let workflow = { id:'test', name:'Browser test', enabled:false, trigger:{type:'manual'}, nodes:[], edges:[], inputs:[] };
  let authorizationActive = false;
  let failSave=false, saves=0, runs=0; const historyRuns=[];
  const server = http.createServer(async(req,res)=>{
    const u=new URL(req.url,'http://local'); res.setHeader('Content-Type','application/json');
    if(u.pathname==='/bundle.js'){res.setHeader('Content-Type','text/javascript; charset=utf-8');res.end(bundle);return;}
    if(u.pathname==='/frame'){res.setHeader('Content-Type','text/html; charset=utf-8');res.end('<!doctype html><meta charset="utf-8"><body><script src="/bundle.js"></script></body>');return;}
    if(u.pathname==='/') {res.setHeader('Content-Type','text/html; charset=utf-8');res.end(`<style>body{margin:0}iframe{position:absolute;border:0;height:100%;}#canvas{inset:0;width:100%}#trigger{left:350px;top:60px;width:560px;height:180px}#controls{left:330px;bottom:20px;width:700px;height:120px}#catalog{left:0;top:170px;width:232px;height:560px}#properties{right:0;top:170px;width:300px;height:560px}@media(max-width:767px){#catalog,#properties{display:none}}</style><iframe id="canvas" src="/frame?id=test&documentId=d1&widgetRole=canvas"></iframe><iframe id="trigger" src="/frame?id=test&documentId=d1&widgetRole=trigger"></iframe><iframe id="controls" src="/frame?id=test&documentId=d1&widgetRole=controls"></iframe><iframe id="catalog" src="/frame?id=test&documentId=d1&widgetRole=nodeCatalog"></iframe><iframe id="properties" src="/frame?id=test&documentId=d1&widgetRole=properties"></iframe><script>addEventListener('message',e=>{if(e.data?.source==='canvas-document')for(const f of document.querySelectorAll('iframe'))f.contentWindow.postMessage(e.data,location.origin)});</script>`);return;}
    if(u.pathname==='/flows/workflows/test' && req.method==='PUT') {let body='';for await(const chunk of req) body+=chunk;saves++;if(failSave){res.statusCode=500;res.end(JSON.stringify({success:false,error:'offline test'}));return;}workflow={...workflow,...JSON.parse(body)}; if(workflow.trigger.type==='webhook'&&!workflow.trigger.webhookToken)workflow.trigger.webhookToken='generated-token';res.end(JSON.stringify({success:true,workflow}));return;}
    if(u.pathname==='/flows/workflows/test/authorization') {
      if(req.method==='POST') { let body=''; for await(const chunk of req) body+=chunk; assert.equal(JSON.parse(body).scopeHash, 'scope1'); authorizationActive=true; }
      if(req.method==='DELETE') authorizationActive=false;
      res.end(JSON.stringify({success:true,authorization:{active:authorizationActive,scopeHash:'scope1',actions:[{nodeId:'n1',package:'desta-casa',tool:'solicitar',args:{property:'A'}}]}})); return;
    }
    if(u.pathname==='/flows/workflows/test/run'){runs++;const run={id:'r1',status:'ok',nodes:[],input:{},logs:[],startedAt:new Date().toISOString()};historyRuns.push(run);res.end(JSON.stringify({success:true,run}));return;}
    if(u.pathname==='/flows/workflows/test'){res.end(JSON.stringify({success:true,workflow}));return;}
    if(u.pathname==='/flows/runs'){res.end(JSON.stringify({success:true,runs:historyRuns}));return;}
    res.end(JSON.stringify({success:true,tools:[],workflows:[],discovered:[],suggestions:[],runs:[],fields:[]}));
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const browser=await puppeteer.launch({headless:true,args:['--no-sandbox','--disable-dev-shm-usage']});
  try {
    const page=await browser.newPage();const errors=[];page.on('pageerror',e=>{errors.push(e.message);console.error('BROWSER',e.stack)});await page.setViewport({width:1400,height:900});await page.goto(`http://127.0.0.1:${server.address().port}`);
    const frame= async id => (await page.$('#'+id)).contentFrame();
    let canvas=await frame('canvas'),catalog=await frame('catalog'),properties=await frame('properties'),trigger=await frame('trigger'),controls=await frame('controls');
    await canvas.waitForSelector('.node',{visible:true,timeout:10000}).catch(async e=>{console.error(await canvas.evaluate(()=>document.body.innerText));throw e});await catalog.waitForSelector('.pitem',{visible:true});
    await properties.waitForSelector('.vars');
    for (const theme of ['dark', 'light']) {
      const appearance = await properties.evaluate(theme => {
        document.querySelector('.ed').dataset.theme = theme;
        const vars = getComputedStyle(document.querySelector('.vars'));
        const inspector = getComputedStyle(document.querySelector('.inspector'));
        return { margin: parseFloat(vars.marginTop), width: inspector.scrollbarWidth, color: inspector.scrollbarColor };
      }, theme);
      assert.ok(appearance.margin >= 12);
      assert.equal(appearance.width, 'thin');
      assert.notEqual(appearance.color, 'auto');
    }
    const bounds=await canvas.$eval('.node',e=>{const r=e.getBoundingClientRect();return {x:r.x,y:r.y,w:r.width,h:r.height}});assert.ok(bounds.x>=232 && bounds.x+bounds.w<=1100,JSON.stringify(bounds));
    const clickText=async(f,selector,text)=>f.evaluate((s,t)=>{const b=[...document.querySelectorAll(s)].find(e=>e.textContent.trim()===t);if(!b)throw Error('Missing '+t);b.click()},selector,text);
    await clickText(controls, 'button', 'Autorizações');
    await canvas.waitForSelector('dialog[open]', { visible:true });
    await canvas.waitForFunction(() => document.querySelector('dialog').textContent.includes('desta-casa.solicitar'));
    await clickText(canvas, 'dialog button', 'Autorizar execuções futuras');
    await canvas.waitForFunction(() => document.querySelector('dialog [role=status]').textContent === 'Autorização ativa');
    assert.equal(authorizationActive, true);
    await clickText(canvas, 'dialog button', 'Revogar autorização');
    await canvas.waitForFunction(() => document.querySelector('dialog [role=status]').textContent === 'Sem autorização válida');
    assert.equal(authorizationActive, false);
    await clickText(canvas, 'dialog button', 'Fechar');
    await canvas.$eval('[aria-label="Nome do Flow"]', e => { e.value='Renamed flow'; e.dispatchEvent(new Event('input',{bubbles:true})); e.dispatchEvent(new Event('blur')); });
    await controls.waitForSelector('.flow-enabled input');
    await controls.click('.flow-enabled input');
    await new Promise(r=>setTimeout(r,600));
    assert.equal(workflow.name,'Renamed flow'); assert.equal(workflow.enabled,true);
    await clickText(catalog,'.pitem','Log');
    await canvas.waitForFunction(()=>document.querySelectorAll('.node').length===2);
    await properties.waitForSelector('.inspector__head input');await properties.$eval('.inspector__head input',e=>{e.value='Edited log';e.dispatchEvent(new Event('input',{bubbles:true}))});
    await canvas.waitForFunction(()=>document.body.textContent.includes('Edited log'));
    for (const label of ['Webhook','Cron','Date','Semantic','Manual']) { await clickText(trigger,'.seg',label); await new Promise(r=>setTimeout(r,250)); }
    await clickText(trigger,'.seg','Event');await trigger.type('input[list="tb-events"]','test:*');
    await controls.waitForFunction(()=>document.querySelector('.save-state')?.textContent==='Salvo',{timeout:8000}).catch(async e=>{console.error('SAVE STATE',await canvas.$eval('.save-state',e=>e.textContent),saves,workflow);throw e});
    // Connect by tapping an output then its destination, the same path used on touch screens.
    await canvas.click('.node .port--out');
    const contrast = await canvas.$eval('.linkbanner', e => { const s=getComputedStyle(e); return s.color !== s.backgroundColor; });
    assert.equal(contrast,true);
    await canvas.click('.node:nth-of-type(2) .node__body');
    await canvas.waitForFunction(()=>document.querySelectorAll('path.edge').length===1);
    await new Promise(r=>setTimeout(r,600));assert.equal(workflow.trigger.event,'test:*');assert.equal(workflow.nodes[1].name,'Edited log');assert.equal(workflow.edges.length,1);
    failSave=true;await controls.click('[title="Save workflow"]');await canvas.waitForFunction(()=>document.body.textContent.includes('offline test'),{timeout:4000}).catch(async e=>{console.error('FAIL SAVE',saves,await canvas.$eval('[title="Save workflow"]',e=>({disabled:e.disabled,rect:e.getBoundingClientRect().toJSON()})));await page.screenshot({path:'/tmp/flows-browser.png'});throw e});await controls.click('[title="Test with a trigger payload"]');await new Promise(r=>setTimeout(r,400));assert.equal(runs,0);assert.equal(await canvas.$('.testsheet'),null);
    failSave=false;await controls.click('[title="Save workflow"]');await controls.waitForFunction(()=>document.querySelector('.save-state')?.textContent==='Salvo',{timeout:8000}).catch(async e=>{console.error('SAVE STATE',await canvas.$eval('.save-state',e=>e.textContent),saves,workflow);throw e});
    await controls.click('[title="Test with a trigger payload"]'); await canvas.waitForSelector('.testsheet__foot .btn--primary'); await canvas.click('.testsheet__foot .btn--primary'); await canvas.waitForSelector('.runpanel'); assert.equal(runs,1);
    await page.evaluate(()=>document.querySelector('#canvas').contentWindow.postMessage({source:'canvas-document',version:2,documentId:'d1',kind:'request',request:{type:'camera',detail:{action:'fit'}}},location.origin));
    assert.equal(await canvas.$('.zoomctl'),null);
    assert.equal(await canvas.$('.canvas__triggerbar'),null);
    const beforeZoom=await canvas.$eval('.world',e=>e.style.transform);
    await page.evaluate(()=>document.querySelector('#canvas').contentWindow.postMessage({source:'canvas-document',version:2,documentId:'d1',kind:'request',request:{type:'camera',detail:{action:'zoom',factor:.8}}},location.origin));
    await canvas.waitForFunction(old=>document.querySelector('.world').style.transform!==old,{},beforeZoom);
    await page.reload();canvas=await frame('canvas');await canvas.waitForFunction(()=>document.querySelectorAll('.node').length===2);assert.equal(await canvas.$$eval('path.edge',x=>x.length),1);
    await page.setViewport({width:390,height:844});await canvas.waitForSelector('.mobilebar',{visible:true});await clickText(canvas,'.mbtn','Node'); await canvas.waitForSelector('.palette.drawer-open',{visible:true}); await clickText(canvas,'.palette .pitem','Set variable'); await canvas.waitForFunction(()=>document.querySelectorAll('.node').length===3); await page.screenshot({path:'/tmp/flows-mobile-verified.png'});
    assert.ok(saves>0);assert.deepEqual(errors,[]);
  } finally {await browser.close();await new Promise(r=>server.close(r));}
});
