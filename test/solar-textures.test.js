import test from 'node:test';
import assert from 'node:assert/strict';
import {fitTextureDimensions} from '../apps/web/src/solar-gl.js';
test('4K detail maps and low-tier maps fit the actual GPU texture limit without stretching or upscaling',()=>{
  assert.deepEqual(fitTextureDimensions(4096,2048,2048),{width:2048,height:1024});
  assert.deepEqual(fitTextureDimensions(4096,2048,512),{width:512,height:256});
  assert.deepEqual(fitTextureDimensions(1024,512,4096),{width:1024,height:512});
  assert.deepEqual(fitTextureDimensions(2048,128,1024),{width:1024,height:64});
  assert.deepEqual(fitTextureDimensions(100,300,200),{width:66,height:200});
  assert.throws(()=>fitTextureDimensions(0,2048,1024));
});
