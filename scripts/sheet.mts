import { createCanvas, loadImage } from '@napi-rs/canvas'; import { writeFileSync } from 'fs';
const names=process.argv.slice(2);
const cols=3, rows=Math.ceil(names.length/cols);
const cv=createCanvas(240*cols,160*rows); const ctx=cv.getContext('2d');
for (let i=0;i<names.length;i++){ try { const im=await loadImage('/tmp/t/'+names[i]+'.png'); ctx.drawImage(im,(i%cols)*240,Math.floor(i/cols)*160); } catch {} }
writeFileSync('/tmp/t/sheet.png', cv.toBuffer('image/png'));
