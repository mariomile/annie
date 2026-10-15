"""Valida ogni caso contro gli schemi e genera dataset/cases.jsonl + gold/labels.jsonl (layout spec §5.2)."""
import json,glob,os,sys
from jsonschema import Draft202012Validator
from referencing import Registry,Resource
base=os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
lead=json.load(open(f"{base}/schema/lead.schema.json")); case=json.load(open(f"{base}/schema/case.schema.json"))
reg=Registry().with_resources([(lead["$id"],Resource.from_contents(lead)),(case["$id"],Resource.from_contents(case))])
v=Draft202012Validator(case,registry=reg); errs=0
os.makedirs(f"{base}/dataset",exist_ok=True); os.makedirs(f"{base}/gold",exist_ok=True)
with open(f"{base}/dataset/cases.jsonl","w") as fc, open(f"{base}/gold/labels.jsonl","w") as fg:
  for p in sorted(glob.glob(f"{base}/cases/*.json")):
    c=json.load(open(p))
    for e in v.iter_errors(c): errs+=1; print(os.path.basename(p),list(e.path),e.message)
    if c["expected"]["lead"]:
      assert c["expected"]["lead"]["missingFields"]==c["expected"]["missingFields"],p
      if c["expected"]["draft"]: assert set(c["expected"]["draft"]["mustAsk"])<=set(c["expected"]["missingFields"]) or c["expected"]["flow"]["expectedStatusAfterPipeline"]=="failed",p
    fc.write(json.dumps(dict(id=c["id"],tags=c["tags"],email=c["email"]),ensure_ascii=False)+"\n")
    fg.write(json.dumps(dict(id=c["id"],**c["expected"]),ensure_ascii=False)+"\n")
print("errori:",errs); sys.exit(1 if errs else 0)
