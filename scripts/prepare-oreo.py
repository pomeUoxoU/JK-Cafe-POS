from pathlib import Path
from PIL import Image
import numpy as np
from scipy import ndimage
import json
out=Path('public/images/oreo/processed');out.mkdir(exist_ok=True)
manifest=[]
for i,p in enumerate(sorted(Path('public/images/oreo').glob('*.png'))):
 im=Image.open(p).convert('RGBA');a=np.array(im); labels,n=ndimage.label(a[:,:,3]>24); sizes=np.bincount(labels.ravel());sizes[0]=0
 ids=np.argsort(sizes)[::-1]; chosen=[ids[0]]+[v for v in ids[1:] if sizes[v]>450][:1]
 for j,label in enumerate(chosen):
  mask=ndimage.binary_dilation(labels==label,iterations=2);b=a.copy();b[:,:,3]=np.where(mask,b[:,:,3],0)
  cut=Image.fromarray(b);cut=cut.crop(cut.getbbox());cut.thumbnail((256,256),Image.Resampling.LANCZOS)
  canvas=Image.new('RGBA',(272,272));canvas.alpha_composite(cut,((272-cut.width)//2,(272-cut.height)//2))
  name=f'{"piece" if j==0 else "crumb"}-{i:02}.png';canvas.save(out/name,optimize=True)
  manifest.append(dict(file=name,source=p.name,pixels=int(sizes[label])))
(out/'manifest.json').write_text(json.dumps(manifest,ensure_ascii=False,indent=2),encoding='utf-8')
print(len(manifest),'assets',sum(p.stat().st_size for p in out.glob('*.png')),'bytes')
