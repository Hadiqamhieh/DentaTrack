import { useState, useRef, useEffect } from "react";
import { supabase } from "./supabaseClient";
import {
  newId, loadProfile, saveProfile, loadPractices, syncPractices,
  loadProduction, syncProduction, loadExpenses, syncExpenses,
  loadBanks, syncBanks, loadBankRules, syncBankRules,
  loadConnectedAccounts, syncConnectedAccounts,
} from "./data";

const useIsMobile = () => {
  const [isMobile, setIsMobile] = useState(typeof window !== "undefined" ? window.innerWidth < 720 : false);
  useEffect(() => {
    const onResize = () => setIsMobile(window.innerWidth < 720);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  return isMobile;
};

const GlobalStyles = () => (
  <style>{`
    .dt-app { -webkit-tap-highlight-color: transparent; }
    .dt-table-wrap { overflow-x: auto; }
    @media (max-width: 720px) {
      .dt-grid-cols { grid-template-columns: 1fr !important; }
      .dt-hide-mobile { display: none !important; }
      .dt-card-table thead { display: none; }
      .dt-card-table, .dt-card-table tbody, .dt-card-table tr, .dt-card-table td { display: block; width: 100%; }
      .dt-card-table tr { border: 1px solid #e2e8f0; border-radius: 10px; margin-bottom: 10px; padding: 10px 12px; background: #fff; }
      .dt-card-table td { padding: 4px 0 !important; border: none !important; text-align: left !important; }
      .dt-card-table td[data-label]::before { content: attr(data-label); display: block; font-size: 10px; color: #94a3b8; text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 2px; }
      .dt-modal-overlay { align-items: stretch !important; justify-content: stretch !important; padding: 0 !important; }
      .dt-modal-card { width: 100% !important; max-width: 100% !important; height: 100%; max-height: 100% !important; border-radius: 0 !important; padding: 20px !important; }
    }
  `}</style>
);

const fmt = (n) => new Intl.NumberFormat("en-CA", { style:"currency", currency:"CAD", maximumFractionDigits:0 }).format(n);
const fmtFull = (n) => new Intl.NumberFormat("en-CA", { style:"currency", currency:"CAD" }).format(n);
const pct = (a, b) => b ? ((a/b)*100).toFixed(1)+"%" : "—";

function buildMatches(expenses, banks) {
  const usedBankIds = new Set();
  const pairs = [];
  for (const exp of expenses) {
    if (!exp.taxDeductible) continue;
    const expTime = new Date(exp.date).getTime();
    for (const b of banks) {
      if (b.amount >= 0 || usedBankIds.has(b.id)) continue;
      const dayDiff = Math.abs(new Date(b.date).getTime() - expTime) / 86400000;
      const amtMatch = Math.abs(Math.abs(b.amount) - exp.amount) < 1;
      const vendorMatch = b.description.toLowerCase().split(/\s+/).some(w => w.length > 3 && exp.vendor.toLowerCase().includes(w));
      if (amtMatch && (vendorMatch || dayDiff <= 1)) {
        pairs.push({ expenseId: exp.id, bankId: b.id });
        usedBankIds.add(b.id);
        break;
      }
    }
  }
  return pairs;
}

// ── Bank Rules Engine ──────────────────────────────────────────────────────────
const RULES_KEY = "dt_bank_rules_v2";

function loadRules() {
  try { return JSON.parse(localStorage.getItem(RULES_KEY)||"[]"); }
  catch { return []; }
}
function saveRules(rules) {
  try { localStorage.setItem(RULES_KEY, JSON.stringify(rules)); } catch {}
}

// Test if a rule matches a bank description
function ruleMatches(rule, description) {
  const desc = description.toLowerCase();
  const term = rule.matchText.toLowerCase();
  if (rule.matchType==="contains")    return desc.includes(term);
  if (rule.matchType==="starts_with") return desc.startsWith(term);
  if (rule.matchType==="equals")      return desc === term;
  return false;
}

// Apply all rules to a bank transaction list — first matching rule wins
function applyRules(banks, rules) {
  return banks.map(b => {
    if (b.userTagged) return b;
    const match = rules.find(r => ruleMatches(r, b.description));
    if (!match) return { ...b, matchedRule:null };
    return {
      ...b,
      type:               match.type               || b.type,
      practiceId:         match.practiceId         || b.practiceId,
      category:           match.category           || b.category,
      taxDeductible:      match.taxDeductible      ?? b.taxDeductible,
      deductibleFraction: match.deductibleFraction ?? b.deductibleFraction,
      corpExpense:        match.corpExpense         ?? b.corpExpense,
      autoTagged:  true,
      matchedRule: match.id,
    };
  });
}

// Create a rule object from a tagging action
function ruleFromTag(description, updates) {
  // Use the most significant word(s) from the description as the match text
  const cleaned = description.replace(/[#\d]{3,}/g,"").trim(); // strip long numbers
  const words   = cleaned.split(/\s+/).filter(w=>w.length>2).slice(0,2).join(" ");
  return {
    id:          newId(),
    matchText:   words || description.slice(0,20),
    matchType:   "contains",
    type:        updates.type,
    practiceId:  updates.practiceId  || null,
    category:    updates.category    || null,
    taxDeductible:      updates.taxDeductible      ?? null,
    deductibleFraction: updates.deductibleFraction ?? null,
    corpExpense:        updates.corpExpense         ?? null,
    appliedCount: 1,
    createdFrom:  "auto",
  };
}


const SEED_PRACTICES = [
  { id:"p1", name:"Sunshine Dental",      address:"123 Main St", city:"Toronto",     province:"ON", postalCode:"M5V 1A1", pct:35, basis:"collections", deductsLabFees:true,  guarantee:0, color:"#0F6E56" },
  { id:"p2", name:"Meadow Family Dental", address:"456 Oak Ave",  city:"Mississauga", province:"ON", postalCode:"L5B 2C3", pct:30, basis:"production",  deductsLabFees:false, guarantee:0, color:"#1e40af" },
];

// Production is now a simple daily total per practice — no procedure-level detail.
const SEED_PRODUCTION = [
  { id:1, date:"2026-06-02", production:1570, labFees:0,   source:"daysheet", practiceId:"p1" },
  { id:2, date:"2026-06-03", production:280,  labFees:0,   source:"manual",   practiceId:"p2" },
  { id:3, date:"2026-06-04", production:180,  labFees:0,   source:"daysheet", practiceId:"p1" },
  { id:4, date:"2026-06-05", production:220,  labFees:0,   source:"daysheet", practiceId:"p2" },
  { id:5, date:"2026-06-09", production:2400, labFees:650, source:"manual",   practiceId:"p1" },
  { id:6, date:"2026-06-10", production:180,  labFees:0,   source:"daysheet", practiceId:"p2" },
  { id:7, date:"2026-06-11", production:1100, labFees:280, source:"daysheet", practiceId:"p1" },
];

const SEED_EXPENSES = [
  { id:1, date:"2026-06-01", vendor:"Patterson Dental Supply",    category:"Supplies",      amount:420,  taxDeductible:true,  corpExpense:true,  receipt:false },
  { id:2, date:"2026-06-03", vendor:"ProLab Ceramics",            category:"Lab Fees",       amount:680,  taxDeductible:true,  corpExpense:true,  receipt:true  },
  { id:3, date:"2026-06-05", vendor:"AGD CE Course",              category:"Education / CE", amount:395,  taxDeductible:true,  corpExpense:false, receipt:true  },
  { id:4, date:"2026-06-06", vendor:"TDIC Malpractice Insurance", category:"Insurance",      amount:210,  taxDeductible:true,  corpExpense:false, receipt:false },
  { id:5, date:"2026-06-08", vendor:"Dentrix Software",           category:"Software",       amount:89,   taxDeductible:true,  corpExpense:true,  receipt:true  },
  { id:6, date:"2026-06-10", vendor:"Starbucks",                  category:"Personal",       amount:18,   taxDeductible:false, corpExpense:false, receipt:false },
  { id:7, date:"2026-06-11", vendor:"DEA Registration",           category:"Licensing",      amount:888,  taxDeductible:true,  corpExpense:false, receipt:true  },
];

const SEED_BANKS = [
  { id:1,  date:"2026-06-06", description:"DIRECT DEP – SUNSHINE DENTAL", amount: 3200,  type:"collection", reviewed:true,  practiceId:"p1", userTagged:true, receipt:null },
  { id:2,  date:"2026-06-07", description:"PATTERSON DENTAL SUPPLY",       amount: -420,  type:"business",   reviewed:true,  practiceId:null, userTagged:true, category:"Supplies",                 taxDeductible:true,  deductibleFraction:1.0, corpExpense:true,  receipt:true,  notes:"Crown case materials" },
  { id:3,  date:"2026-06-08", description:"PROLAB CERAMICS INC",           amount: -680,  type:"business",   reviewed:true,  practiceId:null, userTagged:true, category:"Supplies",                 taxDeductible:true,  deductibleFraction:1.0, corpExpense:true,  receipt:null, notes:"" },
  { id:4,  date:"2026-06-09", description:"STARBUCKS #4832",               amount:  -18,  type:"personal",   reviewed:true,  practiceId:null, userTagged:true, category:"Personal",                 taxDeductible:false, deductibleFraction:0.0, corpExpense:false, receipt:null, notes:"" },
  { id:5,  date:"2026-06-10", description:"DIRECT DEP – MEADOW DENTAL",    amount:  1890, type:"collection", reviewed:true,  practiceId:"p2", userTagged:true, receipt:null },
  { id:6,  date:"2026-06-11", description:"AMAZON.CA",                     amount:   -94, type:"review",     reviewed:false, practiceId:null, userTagged:false, receipt:null, notes:"" },
  { id:7,  date:"2026-06-12", description:"DENTRIX SOFTWARE",              amount:   -89, type:"business",   reviewed:true,  practiceId:null, userTagged:true, category:"Software & Subscriptions", taxDeductible:true,  deductibleFraction:1.0, corpExpense:true,  receipt:true,  notes:"Annual subscription" },
  { id:8,  date:"2026-06-13", description:"UBER",                          amount:   -22, type:"review",     reviewed:false, practiceId:null, userTagged:false, receipt:null, notes:"" },
  { id:9,  date:"2026-06-14", description:"TDIC INSURANCE",                amount:  -210, type:"review",     reviewed:false, practiceId:null, userTagged:false, receipt:null, notes:"" },
  { id:10, date:"2026-06-15", description:"AGD ANNUAL DUES",               amount:  -395, type:"review",     reviewed:false, practiceId:null, userTagged:false, receipt:null, notes:"" },
  // Manual expense — cash purchase, no bank record
  { id:11, date:"2026-06-05", description:"CE COURSE – AGD CONFERENCE",    amount:  -395, type:"business",   reviewed:true,  practiceId:null, userTagged:true, category:"Education / CE",           taxDeductible:true,  deductibleFraction:1.0, corpExpense:false, receipt:true,  notes:"Annual meeting registration", manual:true },
];

// Category config: label, default deductible, deductible fraction, education note
const EXPENSE_CATS = [
  { label:"Supplies",                  deductible:true,  fraction:1.0, note:"Dental supplies you personally purchase — impression materials, PPE, hand instruments, etc. Fully deductible as a business expense." },
  { label:"Education / CE",            deductible:true,  fraction:1.0, note:"Continuing education courses, conferences, and study clubs directly related to your dental practice. Registration fees, course materials, and required textbooks qualify." },
  { label:"Malpractice Insurance",     deductible:true,  fraction:1.0, note:"Professional liability insurance premiums are fully deductible as a cost of practicing. Include CMPA fees or any private malpractice coverage." },
  { label:"Licensing & Registration",  deductible:true,  fraction:1.0, note:"Annual college registration fees, DEA registration (US), and any mandatory licensing costs are fully deductible." },
  { label:"Professional Dues",         deductible:true,  fraction:1.0, note:"Membership fees to professional associations (ODA, CDA, ADA, specialty colleges) directly related to your practice are deductible." },
  { label:"Software & Subscriptions",  deductible:true,  fraction:1.0, note:"Practice management software, clinical reference subscriptions, and professional apps you pay for personally. Must be used for work purposes." },
  { label:"Equipment",                 deductible:true,  fraction:1.0, note:"Smaller tools and instruments you purchase personally are generally deductible. Larger equipment purchases may need to be depreciated over time — flag these for your accountant." },
  { label:"Meals & Entertainment",     deductible:true,  fraction:0.5, note:"Only 50% of eligible business meals are deductible (CRA rule). Qualifies for: meals with referring colleagues, working lunches, CE conference meals. Does not qualify for: solo meals between patients or personal dining." },
  { label:"Work-Related Travel",       deductible:true,  fraction:1.0, note:"Travel between two work locations (e.g. driving between two practices) is deductible. Travel to CE conferences qualifies. Commuting from home to your first practice of the day does not." },
  { label:"Cell Phone",                deductible:true,  fraction:1.0, note:"Only the business-use portion is deductible. If you use your phone 40% for work, 40% of the bill qualifies. Your accountant will determine the exact percentage — enter the full bill amount here." },
  { label:"Home Office",               deductible:true,  fraction:1.0, note:"If you use a dedicated space at home exclusively for work admin, you may deduct a proportional share of rent, utilities, and internet. Your accountant calculates the exact eligible percentage — enter actual costs here." },
  { label:"Other",                     deductible:true,  fraction:1.0, note:"Use for legitimate business expenses that don't fit another category. Add a clear description so your accountant can verify deductibility." },
  { label:"Personal",                  deductible:false, fraction:0.0, note:"Personal expenses are not deductible and won't count toward your tax estimate. Keep these separate from business spending." },
];
const EXPENSE_CAT_LABELS = EXPENSE_CATS.map(c=>c.label);
const getCategory = (label) => EXPENSE_CATS.find(c=>c.label===label) || EXPENSE_CATS[EXPENSE_CATS.length-1];
const CA_PROVINCES = ["AB","BC","MB","NB","NL","NS","NT","NU","ON","PE","QC","SK","YT"];
const PRACTICE_COLORS = ["#0F6E56","#1e40af","#7c3aed","#b45309","#be185d","#0e7490"];

const Badge = ({ label, color="teal" }) => {
  const map = { teal:{bg:"#E1F5EE",text:"#0F6E56"}, green:{bg:"#dcfce7",text:"#166534"},
    amber:{bg:"#fef3c7",text:"#92400e"}, red:{bg:"#fee2e2",text:"#991b1b"},
    blue:{bg:"#dbeafe",text:"#1e40af"}, purple:{bg:"#ede9fe",text:"#6d28d9"}, gray:{bg:"#f1f5f9",text:"#475569"} };
  const s = map[color]||map.gray;
  return <span style={{ background:s.bg, color:s.text, padding:"2px 8px", borderRadius:99, fontSize:11, fontWeight:600, letterSpacing:"0.03em", whiteSpace:"nowrap" }}>{label}</span>;
};
const PracticeDot = ({ color, name }) => (
  <span style={{ display:"inline-flex", alignItems:"center", gap:5 }}>
    <span style={{ width:8, height:8, borderRadius:"50%", background:color, flexShrink:0 }} />
    <span style={{ fontSize:12, color:"#475569", fontWeight:500 }}>{name}</span>
  </span>
);
const Card = ({ children, style, className, ...rest }) => (
  <div className={className} style={{ background:"#fff", borderRadius:12, border:"1px solid #e2e8f0", padding:"20px 24px", ...style }} {...rest}>{children}</div>
);
const StatCard = ({ label, value, sub, color="#0F6E56" }) => (
  <Card style={{ flex:1, minWidth:150 }}>
    <div style={{ fontSize:11, color:"#64748b", fontWeight:500, marginBottom:6, textTransform:"uppercase", letterSpacing:"0.06em" }}>{label}</div>
    <div style={{ fontSize:24, fontWeight:700, color, letterSpacing:"-0.02em" }}>{value}</div>
    {sub && <div style={{ fontSize:12, color:"#94a3b8", marginTop:4 }}>{sub}</div>}
  </Card>
);
const Input = ({ label, ...p }) => (
  <div style={{ display:"flex", flexDirection:"column", gap:4 }}>
    {label && <label style={{ fontSize:12, fontWeight:500, color:"#475569" }}>{label}</label>}
    <input {...p} style={{ padding:"8px 10px", border:"1px solid #e2e8f0", borderRadius:8, fontSize:14, color:"#1e293b", background:"#fff", outline:"none", ...p.style }} />
  </div>
);
const Sel = ({ label, children, ...p }) => (
  <div style={{ display:"flex", flexDirection:"column", gap:4 }}>
    {label && <label style={{ fontSize:12, fontWeight:500, color:"#475569" }}>{label}</label>}
    <select {...p} style={{ padding:"8px 10px", border:"1px solid #e2e8f0", borderRadius:8, fontSize:14, color:"#1e293b", background:"#fff", outline:"none", ...p.style }}>{children}</select>
  </div>
);
const Btn = ({ children, variant="primary", size="md", ...p }) => {
  const base = { border:"none", borderRadius:8, fontWeight:600, cursor:"pointer", display:"inline-flex", alignItems:"center", gap:6, minHeight:36 };
  const sz = { sm:{ padding:"7px 12px", fontSize:12, minHeight:32 }, md:{ padding:"10px 16px", fontSize:13, minHeight:40 }, lg:{ padding:"14px 22px", fontSize:15, minHeight:48 } };
  const v = { primary:{background:"#0F6E56",color:"#fff"}, secondary:{background:"#f1f5f9",color:"#334155"},
    danger:{background:"#fee2e2",color:"#991b1b"}, ghost:{background:"transparent",color:"#64748b",border:"1px solid #e2e8f0"},
    amber:{background:"#fef3c7",color:"#92400e"} };
  return <button {...p} style={{ ...base, ...sz[size], ...v[variant], ...p.style }}>{children}</button>;
};
const MatchPill = ({ status }) => {
  if (status==="matched")    return <Badge label="✓ Bank confirmed" color="green" />;
  if (status==="no-bank")    return <Badge label="Pending bank"     color="amber" />;
  if (status==="no-receipt") return <Badge label="Receipt missing"  color="red"   />;
  return null;
};

const ScanModal = ({ title, prompt, onClose, onResult }) => {
  const [file, setFile] = useState(null);
  const [preview, setPreview] = useState(null);
  const [scanning, setScanning] = useState(false);
  const [log, setLog] = useState([]);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const ref = useRef();
  const loadFile = (f) => {
    setFile(f); setResult(null); setLog([]); setError(null);
    const r = new FileReader(); r.onload = e => setPreview(e.target.result); r.readAsDataURL(f);
  };
  const scan = async () => {
    if (!file||!preview) return;
    setScanning(true); setLog([]); setError(null); setResult(null);
    const steps = ["Reading image...","Identifying fields...","Extracting data...","Formatting results..."];
    let i=0; const iv = setInterval(()=>{ if(i<steps.length) setLog(l=>[...l,steps[i++]]); },600);
    try {
      const base64 = preview.split(",")[1];
      const res = await fetch("/api/scan",{ method:"POST", headers:{"Content-Type":"application/json"},
        body:JSON.stringify({ imageBase64:base64, mimeType:file.type||"image/jpeg", prompt:prompt+"\n\nReturn ONLY a raw JSON object." })});
      clearInterval(iv);
      const data = await res.json();
      if(!res.ok) throw new Error(data.error||"Scan failed");
      setLog(steps); setResult(JSON.parse((data.text||"").replace(/```json|```/g,"").trim()));
    } catch { clearInterval(iv); setError("Could not read this image. Try a clearer photo."); }
    setScanning(false);
  };
  return (
    <div className="dt-modal-overlay" style={{ position:"fixed",inset:0,background:"rgba(0,0,0,0.45)",display:"flex",alignItems:"center",justifyContent:"center",zIndex:1000 }}>
      <Card className="dt-modal-card" style={{ width:480,maxHeight:"90vh",overflowY:"auto",padding:28 }}>
        <div style={{ display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:20 }}>
          <div style={{ fontSize:17,fontWeight:700,color:"#1e293b" }}>{title}</div>
          <Btn variant="ghost" size="sm" onClick={onClose}>Close</Btn>
        </div>
        {!file ? (
          <div onClick={()=>ref.current?.click()} onDrop={e=>{e.preventDefault();loadFile(e.dataTransfer.files[0]);}} onDragOver={e=>e.preventDefault()}
            style={{ border:"2px dashed #e2e8f0",borderRadius:12,padding:"40px 24px",textAlign:"center",cursor:"pointer",background:"#fafafa" }}>
            <div style={{ fontSize:32,marginBottom:8 }}>📷</div>
            <div style={{ fontWeight:600,color:"#475569",marginBottom:4 }}>Drop image or click to upload</div>
            <div style={{ fontSize:12,color:"#94a3b8" }}>PNG, JPG, HEIC — phone photos work great</div>
            <input ref={ref} type="file" accept="image/*" style={{ display:"none" }} onChange={e=>loadFile(e.target.files[0])} />
          </div>
        ) : (
          <div>
            <img src={preview} alt="preview" style={{ width:"100%",borderRadius:8,marginBottom:14,maxHeight:200,objectFit:"cover" }} />
            {!result&&!scanning&&(<div style={{ display:"flex",gap:8 }}>
              <Btn variant="secondary" onClick={()=>{setFile(null);setPreview(null);}}>Change</Btn>
              <Btn onClick={scan}>Scan with AI</Btn>
            </div>)}
          </div>
        )}
        {scanning&&(<div style={{ marginTop:16,background:"#0f2215",borderRadius:8,padding:"12px 16px" }}>
          {log.map((l,i)=><div key={i} style={{ color:"#5DCAA5",fontSize:12,fontFamily:"monospace",marginBottom:2 }}>✓ {l}</div>)}
          <div style={{ color:"#5DCAA5",fontSize:12,fontFamily:"monospace" }}>...</div>
        </div>)}
        {error&&<div style={{ marginTop:14,background:"#fee2e2",color:"#991b1b",borderRadius:8,padding:"10px 14px",fontSize:13 }}>{error}</div>}
        {result&&(<div style={{ marginTop:16 }}>
          <div style={{ fontSize:13,fontWeight:600,color:"#475569",marginBottom:10 }}>Extracted — review before importing</div>
          <div style={{ background:"#f8fafc",border:"1px solid #e2e8f0",borderRadius:8,padding:"12px 14px",marginBottom:14 }}>
            {Object.entries(result).map(([k,v])=>(
              <div key={k} style={{ display:"flex",justifyContent:"space-between",fontSize:13,borderBottom:"1px solid #f1f5f9",padding:"4px 0" }}>
                <span style={{ color:"#64748b",textTransform:"capitalize" }}>{k.replace(/_/g," ")}</span>
                <span style={{ color:"#1e293b",fontWeight:500 }}>{Array.isArray(v)?v.length+" items":String(v)}</span>
              </div>
            ))}
          </div>
          <div style={{ display:"flex",gap:8 }}>
            <Btn variant="secondary" onClick={()=>{setFile(null);setPreview(null);setResult(null);}}>Rescan</Btn>
            <Btn onClick={()=>{ onResult(result); onClose(); }}>Import</Btn>
          </div>
        </div>)}
      </Card>
    </div>
  );
};

const EMPTY_PRACTICE = { name:"", address:"", city:"", province:"ON", postalCode:"", pct:30, basis:"collections", deductsLabFees:false, guarantee:0, color:"#0F6E56" };
const PracticeModal = ({ practice, onSave, onClose }) => {
  const [form, setForm] = useState(practice || EMPTY_PRACTICE);
  const set = (k,v) => setForm(f=>({...f,[k]:v}));
  return (
    <div className="dt-modal-overlay" style={{ position:"fixed",inset:0,background:"rgba(0,0,0,0.45)",display:"flex",alignItems:"center",justifyContent:"center",zIndex:1000 }}>
      <Card className="dt-modal-card" style={{ width:520,maxHeight:"90vh",overflowY:"auto",padding:28 }}>
        <div style={{ display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:20 }}>
          <div style={{ fontSize:17,fontWeight:700,color:"#1e293b" }}>{practice?"Edit practice":"Add practice"}</div>
          <Btn variant="ghost" size="sm" onClick={onClose}>Close</Btn>
        </div>
        <div style={{ fontSize:12,fontWeight:600,color:"#94a3b8",marginBottom:10,textTransform:"uppercase",letterSpacing:"0.05em" }}>Practice info</div>
        <div style={{ display:"flex",flexDirection:"column",gap:12,marginBottom:20 }}>
          <Input label="Practice name" value={form.name} onChange={e=>set("name",e.target.value)} placeholder="e.g. Sunshine Dental" />
          <Input label="Street address" value={form.address} onChange={e=>set("address",e.target.value)} placeholder="123 Main St" />
          <div className="dt-grid-cols" style={{ display:"grid",gridTemplateColumns:"1fr 80px 110px",gap:10 }}>
            <Input label="City" value={form.city} onChange={e=>set("city",e.target.value)} placeholder="Toronto" />
            <Sel label="Province" value={form.province} onChange={e=>set("province",e.target.value)}>
              {CA_PROVINCES.map(p=><option key={p}>{p}</option>)}
            </Sel>
            <Input label="Postal code" value={form.postalCode} onChange={e=>set("postalCode",e.target.value)} placeholder="M5V 1A1" />
          </div>
        </div>
        <div style={{ fontSize:12,fontWeight:600,color:"#94a3b8",marginBottom:10,textTransform:"uppercase",letterSpacing:"0.05em" }}>Compensation at this practice</div>
        <div style={{ display:"flex",flexDirection:"column",gap:12,marginBottom:20 }}>
          <div>
            <label style={{ fontSize:12,fontWeight:500,color:"#475569",display:"block",marginBottom:6 }}>Pay percentage: <strong style={{ color:"#0F6E56" }}>{form.pct}%</strong></label>
            <input type="range" min={20} max={50} value={form.pct} onChange={e=>set("pct",+e.target.value)} style={{ width:"100%" }} />
          </div>
          <Sel label="Basis" value={form.basis} onChange={e=>set("basis",e.target.value)}>
            <option value="collections">Collections</option>
            <option value="production">Gross production</option>
            <option value="adjusted">Adjusted production</option>
          </Sel>
          <Input label="Monthly guarantee ($)" type="number" value={form.guarantee} onChange={e=>set("guarantee",+e.target.value)} placeholder="0" />
          <label style={{ display:"flex",alignItems:"flex-start",gap:10,cursor:"pointer",marginTop:4 }}>
            <input type="checkbox" checked={!!form.deductsLabFees} onChange={e=>set("deductsLabFees",e.target.checked)} style={{ width:18,height:18,marginTop:2 }} />
            <div>
              <div style={{ fontSize:13,fontWeight:600,color:"#1e293b" }}>This practice deducts lab fees before my pay %</div>
              <div style={{ fontSize:11,color:"#94a3b8",marginTop:2 }}>If on, you'll log lab fees alongside production and they'll be subtracted before your percentage is applied.</div>
            </div>
          </label>
        </div>
        <div style={{ fontSize:12,fontWeight:600,color:"#94a3b8",marginBottom:10,textTransform:"uppercase",letterSpacing:"0.05em" }}>Colour tag</div>
        <div style={{ display:"flex",gap:8,marginBottom:24 }}>
          {PRACTICE_COLORS.map(c=>(
            <div key={c} onClick={()=>set("color",c)} style={{ width:28,height:28,borderRadius:"50%",background:c,cursor:"pointer",
              border:form.color===c?"3px solid #1e293b":"3px solid transparent" }} />
          ))}
        </div>
        <div style={{ display:"flex",justifyContent:"flex-end",gap:10 }}>
          <Btn variant="secondary" onClick={onClose}>Cancel</Btn>
          <Btn onClick={()=>{ if(!form.name) return; onSave(form); onClose(); }}>Save practice</Btn>
        </div>
      </Card>
    </div>
  );
};

// Quick log modal — the single primary action: log today's production
const LogModal = ({ practices, onSave, onClose }) => {
  const [mode, setMode] = useState("manual"); // manual | scan
  const [date, setDate] = useState(new Date().toISOString().slice(0,10));
  const [practiceId, setPracticeId] = useState(practices[0]?.id||"");
  const [amount, setAmount] = useState("");
  const [labFees, setLabFees] = useState("");
  const [showScan, setShowScan] = useState(false);

  const practice = practices.find(p=>p.id===practiceId);
  const tracksLab = !!practice?.deductsLabFees;

  const save = () => {
    if(!amount||!practiceId) return;
    onSave({ date, practiceId, production:+amount, labFees:+(labFees||0), source:"manual" });
    onClose();
  };

  return (
    <div className="dt-modal-overlay" style={{ position:"fixed",inset:0,background:"rgba(0,0,0,0.45)",display:"flex",alignItems:"center",justifyContent:"center",zIndex:1000 }}>
      {showScan&&<ScanModal title="Scan Day Sheet"
        prompt="Read a dental day sheet / production report. Extract: date (YYYY-MM-DD), total_production (number), total_collection (number if visible), total_lab_fees (number if visible)."
        onClose={()=>setShowScan(false)}
        onResult={r=>{ onSave({ date:r.date||date, practiceId, production:+(r.total_production||0), labFees:+(r.total_lab_fees||0), source:"daysheet" }); onClose(); }} />}
      <Card className="dt-modal-card" style={{ width:420,padding:28,overflowY:"auto",maxHeight:"90vh" }}>
        <div style={{ display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:20 }}>
          <div style={{ fontSize:17,fontWeight:700,color:"#1e293b" }}>Log today's production</div>
          <Btn variant="ghost" size="sm" onClick={onClose}>Close</Btn>
        </div>

        <div style={{ display:"flex",gap:2,background:"#f1f5f9",borderRadius:10,padding:3,marginBottom:18 }}>
          <button onClick={()=>setMode("manual")} style={{ flex:1,padding:"8px 0",border:"none",borderRadius:8,fontSize:13,fontWeight:600,cursor:"pointer",background:mode==="manual"?"#fff":"transparent",color:mode==="manual"?"#0F6E56":"#64748b" }}>Type it in</button>
          <button onClick={()=>setMode("scan")} style={{ flex:1,padding:"8px 0",border:"none",borderRadius:8,fontSize:13,fontWeight:600,cursor:"pointer",background:mode==="scan"?"#fff":"transparent",color:mode==="scan"?"#0F6E56":"#64748b" }}>📋 Scan day sheet</button>
        </div>

        <div style={{ display:"flex",flexDirection:"column",gap:14 }}>
          <Sel label="Practice" value={practiceId} onChange={e=>setPracticeId(e.target.value)}>
            {practices.map(pr=><option key={pr.id} value={pr.id}>{pr.name}</option>)}
          </Sel>
          <Input label="Date" type="date" value={date} onChange={e=>setDate(e.target.value)} />

          {mode==="manual" ? (
            <>
              <Input label="Total production today ($)" type="number" value={amount} onChange={e=>setAmount(e.target.value)} placeholder="0" autoFocus />
              {tracksLab&&(
                <Input label="Lab fees today ($, if any)" type="number" value={labFees} onChange={e=>setLabFees(e.target.value)} placeholder="0" />
              )}
              <Btn size="lg" onClick={save} style={{ justifyContent:"center", marginTop:6 }}>Save</Btn>
            </>
          ) : (
            <Btn size="lg" onClick={()=>setShowScan(true)} style={{ justifyContent:"center", marginTop:6 }}>📷 Take or upload a photo</Btn>
          )}
        </div>
      </Card>
    </div>
  );
};

// Email report modal
// ── Tax constants (2026, Ontario combined federal+provincial — for estimate purposes only) ──
const TAX_BRACKETS_2026 = [
  { upTo:18930,  rate:0.00  }, // low-income reduction zeroes out Ontario tax below this line, simplified
  { upTo:52886,  rate:0.2005 },
  { upTo:57375,  rate:0.2465 },
  { upTo:91954,  rate:0.2965 },
  { upTo:105775, rate:0.3148 },
  { upTo:150000, rate:0.3389 },
  { upTo:165430, rate:0.3791 },
  { upTo:220000, rate:0.4397 },
  { upTo:Infinity, rate:0.4641 },
];
const RRSP_PCT = 0.18;
const RRSP_CAP_2026 = 33810;

// Marginal-bracket tax on a given taxable income
function estimateTax(income) {
  if (income <= 0) return 0;
  let tax = 0, lower = 0;
  for (const b of TAX_BRACKETS_2026) {
    const taxableInBand = Math.max(0, Math.min(income, b.upTo) - lower);
    tax += taxableInBand * b.rate;
    lower = b.upTo;
    if (income <= b.upTo) break;
  }
  return tax;
}

const TaxPlanningModal = ({ defaultSalary, onClose }) => {
  const [salary, setSalary] = useState(defaultSalary || 90000);
  const [carryForward, setCarryForward] = useState(0);
  const [contribution, setContribution] = useState(null); // null = not yet touched by user

  const rrspRoom = Math.min(salary * RRSP_PCT, RRSP_CAP_2026) + (+carryForward||0);
  // Default the planned contribution to the full room until the user adjusts it themselves
  const plannedContribution = Math.min(contribution===null ? rrspRoom : contribution, rrspRoom);
  const taxNoRRSP = estimateTax(salary);
  const taxWithContribution = estimateTax(Math.max(0, salary - plannedContribution));
  const taxSaved = taxNoRRSP - taxWithContribution;

  // Build chart data points across a salary range — chart always reflects max-room scenario for the trend line,
  // the live marker reflects the user's actual planned contribution at their chosen salary.
  const maxChartSalary = 500000;
  const points = [];
  for (let s=0; s<=maxChartSalary; s+=10000) {
    const room = Math.min(s*RRSP_PCT, RRSP_CAP_2026) + (+carryForward||0);
    points.push({ salary:s, noRrsp:estimateTax(s), withRrsp:estimateTax(Math.max(0,s-room)) });
  }
  const maxTax = Math.max(...points.map(p=>p.noRrsp));
  const W=560, H=220, padL=50, padB=30, padT=10, padR=10;
  const xScale = s => padL + (s/maxChartSalary)*(W-padL-padR);
  const yScale = t => H-padB - (t/maxTax)*(H-padT-padB);
  const lineNo = points.map(p=>`${xScale(p.salary)},${yScale(p.noRrsp)}`).join(" ");
  const lineWith = points.map(p=>`${xScale(p.salary)},${yScale(p.withRrsp)}`).join(" ");
  // Cap point — where 18% of salary hits the RRSP dollar cap
  const capSalary = RRSP_CAP_2026 / RRSP_PCT;

  return (
    <div className="dt-modal-overlay" style={{ position:"fixed",inset:0,background:"rgba(0,0,0,0.45)",display:"flex",alignItems:"center",justifyContent:"center",zIndex:1000 }}>
      <Card className="dt-modal-card" style={{ width:620,padding:28,overflowY:"auto",maxHeight:"90vh" }}>
        <div style={{ display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:6 }}>
          <div style={{ fontSize:17,fontWeight:700,color:"#1e293b" }}>Tax planning — salary & RRSP</div>
          <Btn variant="ghost" size="sm" onClick={onClose}>Close</Btn>
        </div>
        <div style={{ fontSize:12,color:"#94a3b8",marginBottom:20 }}>Estimate only — Ontario 2026 combined rates, simplified. Confirm with your accountant before acting.</div>

        <div style={{ marginBottom:18 }}>
          <div style={{ display:"flex",justifyContent:"space-between",alignItems:"baseline",marginBottom:6 }}>
            <label style={{ fontSize:13,fontWeight:600,color:"#475569" }}>Salary paid from corp this year</label>
            <span style={{ fontSize:20,fontWeight:800,color:"#1e293b" }}>{fmt(salary)}</span>
          </div>
          <input type="range" min={0} max={500000} step={1000} value={salary} onChange={e=>{ setSalary(+e.target.value); setContribution(null); }} style={{ width:"100%" }} />
          <div style={{ display:"flex",justifyContent:"space-between",fontSize:11,color:"#94a3b8",marginTop:2 }}>
            <span>$0</span><span>$500,000</span>
          </div>
        </div>

        <div style={{ display:"flex",gap:14,alignItems:"end",marginBottom:18,flexWrap:"wrap" }}>
          <Input label="Unused RRSP room carried forward ($)" type="number" value={carryForward} onChange={e=>setCarryForward(e.target.value)} placeholder="0" style={{ flex:1,minWidth:200 }} />
          <span title="You can find your exact RRSP deduction limit on your latest CRA Notice of Assessment, or by logging into CRA My Account." style={{ fontSize:16,cursor:"help",color:"#94a3b8",paddingBottom:8 }}>ⓘ</span>
        </div>

        <div style={{ marginBottom:18 }}>
          <div style={{ display:"flex",justifyContent:"space-between",alignItems:"baseline",marginBottom:6 }}>
            <label style={{ fontSize:13,fontWeight:600,color:"#475569" }}>Planned RRSP contribution this year</label>
            <span style={{ fontSize:20,fontWeight:800,color:"#1e293b" }}>{fmt(plannedContribution)}</span>
          </div>
          <input type="range" min={0} max={Math.max(1,rrspRoom)} step={500} value={plannedContribution} onChange={e=>setContribution(+e.target.value)} style={{ width:"100%" }} />
          <div style={{ display:"flex",justifyContent:"space-between",fontSize:11,color:"#94a3b8",marginTop:2 }}>
            <span>$0</span><span>Max room: {fmt(rrspRoom)}</span>
          </div>
          {contribution!==null&&contribution<rrspRoom&&(
            <button onClick={()=>setContribution(null)} style={{ marginTop:6,background:"none",border:"none",color:"#0F6E56",fontSize:12,fontWeight:600,cursor:"pointer",padding:0 }}>Reset to max room</button>
          )}
        </div>

        <div style={{ display:"flex",gap:14,flexWrap:"wrap",marginBottom:20 }}>
          <StatCard label="RRSP room this year" value={fmt(rrspRoom)} sub={"18% of salary, capped at "+fmt(RRSP_CAP_2026)} color="#1e293b" />
          <StatCard label="Tax without contributing" value={fmt(taxNoRRSP)} color="#1e293b" />
          <StatCard label="Tax with planned contribution" value={fmt(taxWithContribution)} color="#1e293b" />
          <StatCard label="Estimated tax saved" value={fmt(taxSaved)} sub={plannedContribution<rrspRoom ? "less than max room used" : "using full RRSP room"} color="#1e293b" />
        </div>

        <div style={{ fontSize:13,fontWeight:600,color:"#1e293b",marginBottom:10 }}>Tax owed by salary level</div>
        <svg viewBox={`0 0 ${W} ${H}`} style={{ width:"100%",height:"auto",background:"#fafafa",borderRadius:8 }}>
          {/* axes */}
          <line x1={padL} y1={padT} x2={padL} y2={H-padB} stroke="#e2e8f0" />
          <line x1={padL} y1={H-padB} x2={W-padR} y2={H-padB} stroke="#e2e8f0" />
          {/* no-RRSP line */}
          <polyline points={lineNo} fill="none" stroke="#fca5a5" strokeWidth="2.5" />
          {/* with-RRSP line */}
          <polyline points={lineWith} fill="none" stroke="#0F6E56" strokeWidth="2.5" />
          {/* cap marker */}
          {capSalary<=maxChartSalary&&(
            <line x1={xScale(capSalary)} y1={padT} x2={xScale(capSalary)} y2={H-padB} stroke="#cbd5e1" strokeDasharray="4 4" />
          )}
          {/* current salary marker */}
          <line x1={xScale(Math.min(salary,maxChartSalary))} y1={padT} x2={xScale(Math.min(salary,maxChartSalary))} y2={H-padB} stroke="#1e293b" strokeWidth="1.5" />
          <circle cx={xScale(Math.min(salary,maxChartSalary))} cy={yScale(estimateTax(salary))} r="4" fill="#fca5a5" stroke="#fff" strokeWidth="1.5" />
          <circle cx={xScale(Math.min(salary,maxChartSalary))} cy={yScale(taxWithContribution)} r="4" fill="#0F6E56" stroke="#fff" strokeWidth="1.5" />
          {/* x labels */}
          <text x={padL} y={H-10} fontSize="10" fill="#94a3b8">$0</text>
          <text x={W-padR-30} y={H-10} fontSize="10" fill="#94a3b8">{"$"+(maxChartSalary/1000)+"k"}</text>
        </svg>
        <div style={{ display:"flex",gap:18,marginTop:10,fontSize:12,color:"#64748b" }}>
          <span><span style={{ display:"inline-block",width:10,height:10,background:"#fca5a5",borderRadius:99,marginRight:5 }}/>Tax with no contribution</span>
          <span><span style={{ display:"inline-block",width:10,height:10,background:"#0F6E56",borderRadius:99,marginRight:5 }}/>Tax if max RRSP room used (trend) · dot = your planned amount</span>
        </div>
        {capSalary<=maxChartSalary&&(
          <div style={{ marginTop:12,fontSize:12,color:"#94a3b8" }}>
            Dashed line marks {fmt(capSalary)} — the salary level where your RRSP room hits the {fmt(RRSP_CAP_2026)} annual cap. Beyond this, extra salary stops generating extra room.
          </div>
        )}

        <div style={{ marginTop:18,padding:14,background:"#f0fdf4",border:"1px solid #bbf7d0",borderRadius:8,fontSize:12,color:"#166534" }}>
          Note: only salary (not dividends) generates RRSP room. Money left as dividends has different, often lower, immediate personal tax — but contributes nothing to your RRSP. This tool compares the RRSP-driven tax saving at a given salary level; it doesn't model the full salary-vs-dividend corporate tax picture.
        </div>
      </Card>
    </div>
  );
};

const EmailReportModal = ({ agreement, onClose }) => {
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  return (
    <div className="dt-modal-overlay" style={{ position:"fixed",inset:0,background:"rgba(0,0,0,0.45)",display:"flex",alignItems:"center",justifyContent:"center",zIndex:1000 }}>
      <Card className="dt-modal-card" style={{ width:420,padding:28,overflowY:"auto",maxHeight:"90vh" }}>
        <div style={{ display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:20 }}>
          <div style={{ fontSize:17,fontWeight:700,color:"#1e293b" }}>Email my P&L</div>
          <Btn variant="ghost" size="sm" onClick={onClose}>Close</Btn>
        </div>
        {!sent ? (
          <>
            <div style={{ fontSize:13,color:"#64748b",marginBottom:16 }}>We'll generate a P&L summary for June 2026 and send it as a PDF — handy for your accountant.</div>
            <Input label="Send to" type="email" value={email} onChange={e=>setEmail(e.target.value)} placeholder="you@email.com or accountant@firm.com" />
            <Btn size="lg" onClick={()=>setSent(true)} style={{ justifyContent:"center", marginTop:16, width:"100%" }} disabled={!email}>Send report</Btn>
          </>
        ) : (
          <div style={{ textAlign:"center",padding:"20px 0" }}>
            <div style={{ fontSize:32,marginBottom:10 }}>✅</div>
            <div style={{ fontWeight:600,color:"#1e293b",marginBottom:4 }}>Report sent</div>
            <div style={{ fontSize:13,color:"#64748b" }}>Check {email} in a few minutes.</div>
          </div>
        )}
      </Card>
    </div>
  );
};

// ── Home Tab ──────────────────────────────────────────────────────────────────
const EditProductionModal = ({ entry, practices, onSave, onClose }) => {
  const [form, setForm] = useState({ ...entry });
  const pr = practices.find(p=>p.id===form.practiceId);
  return (
    <div className="dt-modal-overlay" style={{ position:"fixed",inset:0,background:"rgba(0,0,0,0.45)",display:"flex",alignItems:"center",justifyContent:"center",zIndex:1000 }}>
      <Card className="dt-modal-card" style={{ width:420,padding:28,overflowY:"auto",maxHeight:"90vh" }}>
        <div style={{ display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:20 }}>
          <div style={{ fontSize:17,fontWeight:700,color:"#1e293b" }}>Edit production entry</div>
          <Btn variant="ghost" size="sm" onClick={onClose}>Close</Btn>
        </div>
        <div style={{ display:"flex",flexDirection:"column",gap:14 }}>
          <Sel label="Practice" value={form.practiceId} onChange={e=>setForm(f=>({...f,practiceId:e.target.value}))}>
            {practices.map(p=><option key={p.id} value={p.id}>{p.name}</option>)}
          </Sel>
          <Input label="Date" type="date" value={form.date} onChange={e=>setForm(f=>({...f,date:e.target.value}))} />
          <Input label="Total production ($)" type="number" value={form.production} onChange={e=>setForm(f=>({...f,production:+e.target.value}))} />
          {pr?.deductsLabFees&&(
            <Input label="Lab fees ($)" type="number" value={form.labFees||0} onChange={e=>setForm(f=>({...f,labFees:+e.target.value}))} />
          )}
          <div style={{ display:"flex",gap:10,justifyContent:"flex-end",marginTop:6 }}>
            <Btn variant="secondary" onClick={onClose}>Cancel</Btn>
            <Btn onClick={()=>onSave(form)}>Save changes</Btn>
          </div>
        </div>
      </Card>
    </div>
  );
};

const HomeTab = ({ production, expenses, banks, agreement, matches, practices, collectionsSummary }) => {
  const [showEmail, setShowEmail] = useState(false);
  const [showTax, setShowTax]     = useState(false);

  const totalProd   = production.reduce((s,r)=>s+r.production,0);
  const totalExp    = banks.filter(b=>b.type==="business"&&b.taxDeductible).reduce((s,b)=>s+Math.abs(b.amount)*(b.deductibleFraction??1),0);
  const deposits    = banks.filter(b=>b.type==="collection").reduce((s,b)=>s+b.amount,0);
  const expectedPay = practices.reduce((sum,pr)=>{
    const prDeps = banks.filter(b=>b.type==="collection"&&b.practiceId===pr.id).reduce((s,b)=>s+b.amount,0);
    const prLab  = pr.deductsLabFees ? production.filter(r=>r.practiceId===pr.id).reduce((s,r)=>s+(r.labFees||0),0) : 0;
    return sum + Math.max(0, prDeps - prLab) * (pr.pct/100);
  },0);
  const variance = deposits>0 ? (deposits - expectedPay) : 0;
  const net = expectedPay - totalExp;

  const matchedExpIds  = new Set(matches.map(m=>m.expenseId));
  const matchedBankIds = new Set(matches.map(m=>m.bankId));
  const pendingExp     = expenses.filter(e=>e.taxDeductible&&!matchedExpIds.has(e.id));
  const missingReceipt = banks.filter(b=>b.amount<0&&b.type!=="personal"&&!matchedBankIds.has(b.id));

  const months = ["Jan","Feb","Mar","Apr","May","Jun"];
  const bars   = [38000,44200,51000,47800,56300,totalProd];
  const barMax = Math.max(...bars);

  return (
    <div style={{ display:"flex",flexDirection:"column",gap:20 }}>
      {showEmail&&<EmailReportModal agreement={agreement} onClose={()=>setShowEmail(false)} />}
      {showTax&&<TaxPlanningModal defaultSalary={agreement.salary?agreement.salary*12:90000} onClose={()=>setShowTax(false)} />}

      {/* Underpayment alert */}
      {Math.abs(variance)>50&&(
        <div style={{ background:variance<0?"#fee2e2":"#dcfce7",border:"1px solid "+(variance<0?"#fca5a5":"#86efac"),borderRadius:10,padding:"12px 18px",display:"flex",alignItems:"center",gap:10 }}>
          <span>{variance<0?"⚠️":"✅"}</span>
          <div>
            <div style={{ fontSize:13,fontWeight:700,color:variance<0?"#991b1b":"#166534" }}>
              {variance<0?"Possible underpayment of "+fmt(Math.abs(variance)):fmt(variance)+" ahead of expected pay"}
            </div>
            <div style={{ fontSize:12,color:variance<0?"#b91c1c":"#15803d" }}>Expected {fmt(expectedPay)} · Received {fmt(deposits)}</div>
          </div>
        </div>
      )}

      {/* Receipt matching alert */}
      {(pendingExp.length>0||missingReceipt.length>0)&&(
        <div style={{ background:"#fffbeb",border:"1px solid #fde68a",borderRadius:10,padding:"12px 18px",display:"flex",gap:10 }}>
          <span>🔗</span>
          <div>
            <div style={{ fontSize:13,fontWeight:700,color:"#92400e",marginBottom:4 }}>Receipt matching needs attention</div>
            {pendingExp.length>0&&<div style={{ fontSize:12,color:"#b45309" }}>· {pendingExp.length} expense(s) not yet confirmed by bank</div>}
            {missingReceipt.length>0&&<div style={{ fontSize:12,color:"#b45309" }}>· {missingReceipt.length} bank debit(s) have no receipt on file</div>}
          </div>
        </div>
      )}

      {/* Stat cards */}
      <div style={{ display:"flex",gap:14,flexWrap:"wrap" }}>
        <StatCard label="Total production"   value={fmt(totalProd)}   sub={"across "+practices.length+" practices"} color="#1e293b" />
        <StatCard label="Collections"        value={fmt(deposits)}    sub={deposits>0&&totalProd>0 ? pct(deposits,totalProd)+" implied rate" : "bank deposits received"} color="#1e293b" />
        <StatCard label="Expected pay"       value={fmt(expectedPay)} sub="based on deposits"                       color="#1e293b" />
        <StatCard label="Deductibles"        value={fmt(totalExp)}    sub={matches.length+" receipts matched"}       color="#1e293b" />
      </div>

      {/* Per-practice cards */}
      <div style={{ display:"flex",gap:14,flexWrap:"wrap" }}>
        {(collectionsSummary||[]).map(({pr,deposits:prDeps,production:prProd,rate})=>{
          const prLab  = pr.deductsLabFees ? production.filter(r=>r.practiceId===pr.id).reduce((s,r)=>s+(r.labFees||0),0) : 0;
          const prPay  = Math.max(0, prDeps - prLab) * (pr.pct/100);
          const rateLow = rate!==null && rate < 70;
          return(
            <Card key={pr.id} style={{ flex:1,minWidth:220,borderTop:"3px solid "+pr.color }}>
              <div style={{ display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:12 }}>
                <div>
                  <div style={{ fontSize:13,fontWeight:700,color:"#1e293b" }}>{pr.name}</div>
                  <div style={{ fontSize:11,color:"#94a3b8",marginTop:2 }}>{pr.pct}% of {pr.basis}</div>
                </div>
                {rateLow&&<span title="Collection rate looks low — consider requesting a collections statement">⚠️</span>}
              </div>
              <div style={{ display:"flex",gap:14,flexWrap:"wrap" }}>
                <div><div style={{ fontSize:11,color:"#94a3b8" }}>Production</div><div style={{ fontWeight:700,color:"#1e293b" }}>{fmt(prProd)}</div></div>
                <div><div style={{ fontSize:11,color:"#94a3b8" }}>Deposits</div><div style={{ fontWeight:700,color:"#1e293b" }}>{fmt(prDeps)}</div></div>
                <div><div style={{ fontSize:11,color:"#94a3b8" }}>Exp. pay</div><div style={{ fontWeight:700,color:"#1e293b" }}>{fmt(prPay)}</div></div>
                {rate!==null&&<div><div style={{ fontSize:11,color:"#94a3b8" }}>Collection rate</div><div style={{ fontWeight:700,color:rateLow?"#991b1b":"#1e293b" }}>{rate.toFixed(0)}%</div></div>}
              </div>
              {prLab>0&&<div style={{ fontSize:11,color:"#94a3b8",marginTop:8 }}>Lab deducted: {fmt(prLab)}</div>}
              {rateLow&&<div style={{ marginTop:8,fontSize:11,color:"#92400e",background:"#fef3c7",padding:"4px 8px",borderRadius:6 }}>Collection rate looks low — request a monthly statement from the practice.</div>}
            </Card>
          );
        })}
      </div>

      {/* Monthly trend chart */}
      <Card>
        <div style={{ fontSize:14,fontWeight:600,color:"#1e293b",marginBottom:16 }}>Monthly production</div>
        <div style={{ display:"flex",alignItems:"flex-end",gap:10,height:110 }}>
          {bars.map((v,i)=>(
            <div key={i} style={{ flex:1,display:"flex",flexDirection:"column",alignItems:"center",gap:4 }}>
              <div style={{ fontSize:10,color:"#94a3b8" }}>{i===5?fmt(v).replace("CA$","$"):""}</div>
              <div style={{ width:"100%",background:i===5?"#0F6E56":"#e2e8f0",borderRadius:"4px 4px 0 0",height:(v/barMax)*86 }} />
              <div style={{ fontSize:11,color:"#94a3b8" }}>{months[i]}</div>
            </div>
          ))}
        </div>
      </Card>

      {/* Net take-home */}
      <Card style={{ background:"#0a1f18",border:"none" }}>
        <div style={{ display:"flex",justifyContent:"space-between",alignItems:"flex-start",flexWrap:"wrap",gap:16 }}>
          <div>
            <div style={{ fontSize:13,color:"#5DCAA5",fontWeight:600,marginBottom:12,textTransform:"uppercase",letterSpacing:"0.05em" }}>Estimated net take-home</div>
            <div style={{ display:"flex",gap:24,flexWrap:"wrap" }}>
              {[["Expected pay",fmt(expectedPay),"#5DCAA5"],["Expenses",fmt(totalExp),"#fca5a5"],["= Net",fmt(net),"#fff"]].map(([l,v,c])=>(
                <div key={l}><div style={{ fontSize:11,color:"#5a7a6a",marginBottom:2 }}>{l}</div><div style={{ fontSize:l==="= Net"?22:16,fontWeight:l==="= Net"?800:600,color:l==="= Net"?"#fff":l==="Expenses"?"#fca5a5":"#e2e8f0" }}>{v}</div></div>
              ))}
            </div>
          </div>
          <div style={{ display:"flex",gap:8,flexWrap:"wrap" }}>
            {agreement.isCorp&&<Btn variant="secondary" onClick={()=>setShowTax(true)}>💰 Tax planning</Btn>}
            <Btn variant="secondary" onClick={()=>setShowEmail(true)}>📧 Email my P&L</Btn>
          </div>
        </div>
        <div style={{ marginTop:14,fontSize:11,color:"#4a6a5a",fontStyle:"italic",borderTop:"1px solid #1a3328",paddingTop:10 }}>
          Estimates based on information you enter. Not tax or financial advice — consult a qualified accountant (CPA/CA).
        </div>
      </Card>
    </div>
  );
};

// ── Production Tab ─────────────────────────────────────────────────────────────
const ProductionTab = ({ production, setProduction, practices }) => {
  const [showLog, setShowLog]     = useState(false);
  const [editEntry, setEditEntry] = useState(null);

  return (
    <div style={{ display:"flex",flexDirection:"column",gap:20 }}>
      {showLog&&<LogModal practices={practices} onClose={()=>setShowLog(false)} onSave={entry=>setProduction(p=>[...p,{...entry,id:newId()}])} />}
      {editEntry&&(
        <EditProductionModal
          entry={editEntry}
          practices={practices}
          onSave={updated=>{ setProduction(p=>p.map(x=>x.id===updated.id?updated:x)); setEditEntry(null); }}
          onClose={()=>setEditEntry(null)}
        />
      )}

      {/* Log action card */}
      <Card style={{ background:"linear-gradient(135deg,#0F6E56,#0a4d3c)",border:"none",padding:"24px 28px" }}>
        <div style={{ display:"flex",justifyContent:"space-between",alignItems:"center",flexWrap:"wrap",gap:16 }}>
          <div>
            <div style={{ color:"#fff",fontSize:17,fontWeight:700,marginBottom:4 }}>Log today's production</div>
            <div style={{ color:"#a8e6cf",fontSize:13 }}>Type it in, or snap a photo of your day sheet</div>
          </div>
          <Btn size="lg" onClick={()=>setShowLog(true)} style={{ background:"#fff",color:"#0F6E56" }}>+ Log production</Btn>
        </div>
      </Card>

      {/* Production log */}
      <Card style={{ padding:0,overflow:"hidden" }}>
        <div style={{ padding:"14px 20px",borderBottom:"1px solid #f1f5f9",display:"flex",justifyContent:"space-between",alignItems:"center" }}>
          <div style={{ fontSize:14,fontWeight:600,color:"#1e293b" }}>Production log</div>
          <div style={{ fontSize:12,color:"#94a3b8" }}>{production.length} entries this month</div>
        </div>
        {production.length===0 ? (
          <div style={{ padding:"40px 20px",textAlign:"center",color:"#94a3b8",fontSize:13 }}>
            <div style={{ fontSize:32,marginBottom:10 }}>📋</div>
            No production logged yet — tap "Log production" above.
          </div>
        ) : (
          [...production].sort((a,b)=>b.date.localeCompare(a.date)).map((entry,i)=>{
            const pr = practices.find(p=>p.id===entry.practiceId);
            return (
              <div key={entry.id} style={{ display:"flex",alignItems:"center",gap:12,padding:"12px 20px",borderBottom:"1px solid #f8fafc",background:i%2===0?"#fff":"#fafafa" }}>
                <div style={{ width:8,height:8,borderRadius:"50%",background:pr?.color||"#e2e8f0",flexShrink:0 }} />
                <div style={{ flex:1,minWidth:0 }}>
                  <div style={{ display:"flex",alignItems:"baseline",gap:8,flexWrap:"wrap" }}>
                    <span style={{ fontSize:13,fontWeight:600,color:"#1e293b" }}>{entry.date}</span>
                    <span style={{ fontSize:12,color:"#64748b" }}>{pr?.name||"—"}</span>
                    {entry.labFees>0&&<span style={{ fontSize:11,color:"#92400e",background:"#fef3c7",padding:"1px 6px",borderRadius:99 }}>Lab: {fmt(entry.labFees)}</span>}
                    <Badge label={entry.source==="daysheet"?"📋 Day sheet":"Manual"} color={entry.source==="daysheet"?"teal":"gray"} />
                  </div>
                </div>
                <div style={{ fontSize:16,fontWeight:700,color:"#1e293b",flexShrink:0 }}>{fmt(entry.production)}</div>
                <div style={{ display:"flex",gap:6,flexShrink:0 }}>
                  <Btn variant="ghost" size="sm" onClick={()=>setEditEntry(entry)}>Edit</Btn>
                  <Btn variant="danger" size="sm" onClick={()=>setProduction(p=>p.filter(x=>x.id!==entry.id))}>Remove</Btn>
                </div>
              </div>
            );
          })
        )}
      </Card>
    </div>
  );
};

// ── Transactions Tab (expenses + bank feed + reconciliation merged) ───────────
// ── Receipt attachment scanner ─────────────────────────────────────────────────
// Scans a receipt and attaches it to an existing bank transaction
const ReceiptScanner = ({ bankId, onAttach, onClose }) => {
  const fileRef = useRef();
  const [scanning, setScanning] = useState(false);
  const [result, setResult]     = useState(null);
  const [error, setError]       = useState(null);

  const scan = async (file) => {
    setScanning(true); setError(null);
    try {
      const base64 = await new Promise((res,rej) => {
        const r = new FileReader();
        r.onload = () => res(r.result.split(",")[1]);
        r.onerror = () => rej(new Error("Read failed"));
        r.readAsDataURL(file);
      });
      const resp = await fetch("/api/scan", {
        method:"POST",
        headers:{ "Content-Type":"application/json" },
        body: JSON.stringify({
          imageBase64: base64,
          mimeType: file.type||"image/jpeg",
          prompt: 'Extract from this receipt: vendor name, date (YYYY-MM-DD), total amount (number). Respond ONLY as JSON: {"vendor":"...","date":"...","amount":0}',
        })
      });
      const data = await resp.json();
      if(!resp.ok) throw new Error(data.error||"Scan failed");
      const text = (data.text||"").replace(/```json|```/g,"").trim();
      const parsed = JSON.parse(text);
      setResult({ ...parsed, imageBase64:base64, mimeType:file.type||"image/jpeg" });
    } catch(e) {
      setError("Couldn't read the receipt — try a clearer photo.");
    }
    setScanning(false);
  };

  return(
    <div className="dt-modal-overlay" style={{ position:"fixed",inset:0,background:"rgba(0,0,0,0.5)",display:"flex",alignItems:"center",justifyContent:"center",zIndex:1001 }}>
      <Card className="dt-modal-card" style={{ width:440,padding:28,overflowY:"auto",maxHeight:"90vh" }}>
        <div style={{ display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:20 }}>
          <div style={{ fontSize:16,fontWeight:700,color:"#1e293b" }}>Attach receipt</div>
          <Btn variant="ghost" size="sm" onClick={onClose}>Close</Btn>
        </div>

        {!result ? (
          <div>
            <div style={{ border:"2px dashed #e2e8f0",borderRadius:12,padding:"32px 20px",textAlign:"center",marginBottom:16,cursor:"pointer" }}
              onClick={()=>fileRef.current?.click()}>
              <div style={{ fontSize:32,marginBottom:8 }}>📷</div>
              <div style={{ fontSize:14,fontWeight:600,color:"#1e293b",marginBottom:4 }}>Take a photo or upload</div>
              <div style={{ fontSize:12,color:"#94a3b8" }}>JPEG, PNG — clear photo of full receipt</div>
              <input ref={fileRef} type="file" accept="image/*" capture="environment" style={{ display:"none" }}
                onChange={e=>{ if(e.target.files[0]) scan(e.target.files[0]); }}/>
            </div>
            {scanning&&<div style={{ textAlign:"center",color:"#64748b",fontSize:13 }}>🔍 Reading receipt…</div>}
            {error&&<div style={{ color:"#991b1b",fontSize:13,textAlign:"center" }}>{error}</div>}
          </div>
        ) : (
          <div>
            <div style={{ background:"#f0fdf4",border:"1px solid #bbf7d0",borderRadius:10,padding:"14px 16px",marginBottom:16 }}>
              <div style={{ fontSize:12,color:"#166534",fontWeight:600,marginBottom:8 }}>Receipt extracted</div>
              <div style={{ display:"flex",flexDirection:"column",gap:6 }}>
                <div style={{ display:"flex",justifyContent:"space-between",fontSize:13 }}>
                  <span style={{ color:"#64748b" }}>Vendor</span>
                  <span style={{ fontWeight:600,color:"#1e293b" }}>{result.vendor||"—"}</span>
                </div>
                <div style={{ display:"flex",justifyContent:"space-between",fontSize:13 }}>
                  <span style={{ color:"#64748b" }}>Date</span>
                  <span style={{ fontWeight:600,color:"#1e293b" }}>{result.date||"—"}</span>
                </div>
                <div style={{ display:"flex",justifyContent:"space-between",fontSize:13 }}>
                  <span style={{ color:"#64748b" }}>Amount</span>
                  <span style={{ fontWeight:600,color:"#1e293b" }}>{result.amount ? "$"+result.amount : "—"}</span>
                </div>
              </div>
            </div>
            <div style={{ fontSize:12,color:"#64748b",marginBottom:16 }}>This receipt will be attached to the transaction as your CRA record.</div>
            <div style={{ display:"flex",gap:10,justifyContent:"flex-end" }}>
              <Btn variant="secondary" onClick={()=>setResult(null)}>Retake</Btn>
              <Btn onClick={()=>onAttach({ imageBase64:result.imageBase64, mimeType:result.mimeType, vendor:result.vendor, date:result.date, amount:result.amount })}>
                Attach receipt ✓
              </Btn>
            </div>
          </div>
        )}
      </Card>
    </div>
  );
};

// ── Manual expense modal (fallback for cash/off-card purchases) ────────────────
const ManualExpenseModal = ({ agreement, onSave, onClose }) => {
  const [form, setForm] = useState({
    date: new Date().toISOString().slice(0,10),
    description:"", category:"Supplies", notes:"",
  });
  const cat = getCategory(form.category);

  return(
    <div className="dt-modal-overlay" style={{ position:"fixed",inset:0,background:"rgba(0,0,0,0.5)",display:"flex",alignItems:"center",justifyContent:"center",zIndex:1001 }}>
      <Card className="dt-modal-card" style={{ width:460,padding:28,overflowY:"auto",maxHeight:"90vh" }}>
        <div style={{ display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:20 }}>
          <div>
            <div style={{ fontSize:16,fontWeight:700,color:"#1e293b" }}>Add manual expense</div>
            <div style={{ fontSize:12,color:"#94a3b8",marginTop:2 }}>For cash or off-card purchases not in your bank feed</div>
          </div>
          <Btn variant="ghost" size="sm" onClick={onClose}>Close</Btn>
        </div>
        <div style={{ display:"flex",flexDirection:"column",gap:14 }}>
          <Input label="Date" type="date" value={form.date} onChange={e=>setForm(f=>({...f,date:e.target.value}))}/>
          <Input label="Vendor / Description" value={form.description} onChange={e=>setForm(f=>({...f,description:e.target.value}))} placeholder="e.g. Cash purchase at dental supply store"/>
          <Input label="Amount ($)" type="number" value={form.amount||""} onChange={e=>setForm(f=>({...f,amount:+e.target.value}))} placeholder="0"/>
          <Sel label="Category" value={form.category} onChange={e=>setForm(f=>({...f,category:e.target.value}))}>
            {EXPENSE_CAT_LABELS.map(c=><option key={c} value={c}>{c}</option>)}
          </Sel>
          {cat&&(
            <div style={{ background:cat.deductible?"#f0fdf4":"#fef2f2",border:"1px solid "+(cat.deductible?"#bbf7d0":"#fecaca"),borderRadius:8,padding:"10px 14px",fontSize:12,color:cat.deductible?"#166534":"#991b1b" }}>
              {cat.fraction<1&&<span style={{ fontWeight:700 }}>50% deductible — </span>}
              {cat.note}
            </div>
          )}
          <Input label="Notes (optional)" value={form.notes} onChange={e=>setForm(f=>({...f,notes:e.target.value}))} placeholder="What was this for?"/>
          <div style={{ fontSize:11,color:"#94a3b8",fontStyle:"italic" }}>
            Estimates only — not tax advice. Confirm with your accountant (CPA/CA).
          </div>
          <div style={{ display:"flex",gap:10,justifyContent:"flex-end",marginTop:4 }}>
            <Btn variant="secondary" onClick={onClose}>Cancel</Btn>
            <Btn onClick={()=>{
              if(!form.description||!form.amount) return;
              onSave({
                id: newId(),
                date: form.date,
                description: form.description,
                amount: -(+form.amount),
                type:"business",
                category: form.category,
                taxDeductible: cat.deductible,
                deductibleFraction: cat.fraction,
                corpExpense: agreement.isCorp && cat.deductible,
                notes: form.notes,
                manual: true,
                receipt: null,
                reviewed: true,
                userTagged: true,
              });
              onClose();
            }}>Save expense</Btn>
          </div>
        </div>
      </Card>
    </div>
  );
};

const TransactionsTab = ({ expenses, setExpenses, banks, setBanks, tagBank, agreement, matches, practices, production, bankRules, addRule }) => {
  const [pendingRule, setPendingRule]     = useState(null);
  const [expandedId, setExpandedId]       = useState(null);
  const [scanningFor, setScanningFor]     = useState(null); // bankId to attach receipt to
  const [showManual, setShowManual]       = useState(false);
  const [sub, setSub]                     = useState("all");

  const SUBS = [
    { key:"all",         label:"All" },
    { key:"feed",        label:"Feed" },
    { key:"deductibles", label:"Deductibles" },
    { key:"reconcile",   label:"Reconciliation" },
  ];
  const bankStatus = (b) => { if(b.amount>0||b.type==="personal") return null; return b.receipt?"matched":"no-receipt"; };
  const bizExp     = banks.filter(b=>b.type==="business"&&b.taxDeductible).reduce((s,b)=>s+Math.abs(b.amount)*(b.deductibleFraction??1),0);
  const deposits   = banks.filter(b=>b.type==="collection").reduce((s,b)=>s+b.amount,0);

  return (
    <div style={{ display:"flex",flexDirection:"column",gap:20 }}>
      {scanningFor&&<ReceiptScanner bankId={scanningFor}
        onAttach={r=>{ setBanks(bk=>bk.map(x=>x.id===scanningFor?{...x,receipt:r}:x)); setScanningFor(null); }}
        onClose={()=>setScanningFor(null)}/>}
      {showManual&&<ManualExpenseModal agreement={agreement}
        onSave={tx=>{ setBanks(bk=>[...bk,tx]); setShowManual(false); }}
        onClose={()=>setShowManual(false)}/>}

      <div style={{ display:"flex",justifyContent:"space-between",alignItems:"center",flexWrap:"wrap",gap:10 }}>
        <div style={{ display:"flex",gap:2,background:"#f1f5f9",borderRadius:10,padding:3,overflowX:"auto" }}>
          {SUBS.map(s=>(
            <button key={s.key} onClick={()=>setSub(s.key)} style={{ padding:"7px 16px",border:"none",borderRadius:8,fontSize:13,fontWeight:600,cursor:"pointer",whiteSpace:"nowrap",background:sub===s.key?"#fff":"transparent",color:sub===s.key?"#0F6E56":"#64748b",boxShadow:sub===s.key?"0 1px 3px rgba(0,0,0,0.1)":"none" }}>{s.label}</button>
          ))}
        </div>
        <Btn variant="ghost" size="sm" onClick={()=>setShowManual(true)}>+ Manual expense</Btn>
      </div>

      <div style={{ display:"flex",gap:14,flexWrap:"wrap" }}>
        <StatCard label="Deductible total"   value={fmt(bizExp)}   sub={banks.filter(b=>b.type==="business"&&b.taxDeductible).length+" transactions"} color="#1e293b"/>
        <StatCard label="Collections banked" value={fmt(deposits)} sub={practices.length+" practices"} color="#1e293b"/>
        <StatCard label="Missing receipts"   value={String(banks.filter(b=>b.type==="business"&&b.taxDeductible&&!b.receipt).length)} sub="deductibles without documentation" color={banks.filter(b=>b.type==="business"&&b.taxDeductible&&!b.receipt).length>0?"#991b1b":"#1e293b"}/>
      </div>

      {banks.filter(b=>b.type==="business"&&b.taxDeductible&&!b.receipt).length>0&&(
        <div onClick={()=>setSub("deductibles")} style={{ background:"#fffbeb",border:"1px solid #fde68a",borderRadius:10,padding:"12px 18px",display:"flex",alignItems:"center",gap:10,cursor:"pointer" }}>
          <span>📄</span>
          <div style={{ flex:1 }}>
            <div style={{ fontSize:13,fontWeight:700,color:"#92400e" }}>{banks.filter(b=>b.type==="business"&&b.taxDeductible&&!b.receipt).length} deductible transactions missing a receipt</div>
            <div style={{ fontSize:12,color:"#b45309" }}>CRA requires receipts for all business expense claims. Tap to review.</div>
          </div>
          <span style={{ fontSize:12,color:"#92400e",fontWeight:600,whiteSpace:"nowrap" }}>Review →</span>
        </div>
      )}

      {(sub==="all"||sub==="feed")&&(
        <Card style={{ padding:0,overflow:"hidden" }}>
          {/* Feed header */}
          <div style={{ padding:"14px 20px",borderBottom:"1px solid #f1f5f9",background:"#f8fafc",display:"flex",justifyContent:"space-between",alignItems:"center" }}>
            <div>
              <div style={{ fontSize:13,fontWeight:600,color:"#1e293b" }}>Bank feed</div>
              <div style={{ fontSize:11,color:"#94a3b8",marginTop:2 }}>
                {banks.filter(b=>!b.reviewed&&!b.userTagged).length > 0
                  ? `${banks.filter(b=>!b.reviewed&&!b.userTagged).length} unreviewed — click any row to tag`
                  : "All transactions reviewed"}
              </div>
            </div>
            <Badge label="Live sync" color="green"/>
          </div>

          {/* Unified transaction list — all transactions, click to expand */}
          <div>
            {[...banks].sort((a,b)=>b.date.localeCompare(a.date)).map((b,i)=>{
              const isOpen   = expandedId === b.id;
              const isTagged = b.userTagged || b.autoTagged;
              const pr       = practices.find(p=>p.id===b.practiceId);
              const pair     = matches.find(m=>m.bankId===b.id);
              const exp      = pair ? expenses.find(e=>e.id===pair.expenseId) : null;
              const st       = bankStatus(b);

              // Row left border color — status indicator
              const borderColor = !isTagged ? "#f59e0b"          // amber = needs review
                                : b.autoTagged ? "#3b82f6"        // blue = auto-tagged by rule
                                : "transparent";                   // clear = reviewed

              return (
                <div key={b.id}>
                  {/* Clickable summary row */}
                  <div
                    onClick={()=>setExpandedId(isOpen ? null : b.id)}
                    style={{ display:"flex",alignItems:"center",gap:12,padding:"12px 20px",
                      borderBottom: isOpen ? "none" : "1px solid #f1f5f9",
                      borderLeft:"3px solid "+borderColor,
                      background: isOpen ? "#f8fafc" : i%2===0?"#fff":"#fafafa",
                      cursor:"pointer",userSelect:"none" }}>
                    {/* Status dot */}
                    <div style={{ width:7,height:7,borderRadius:"50%",flexShrink:0,
                      background: !isTagged?"#f59e0b":b.autoTagged?"#3b82f6":"#e2e8f0" }} />

                    {/* Description + meta */}
                    <div style={{ flex:1,minWidth:0 }}>
                      <div style={{ fontSize:13,fontWeight:500,color:"#1e293b",display:"flex",alignItems:"center",gap:8,flexWrap:"wrap" }}>
                        {b.description}
                        {b.autoTagged&&!b.userTagged&&<span style={{ fontSize:10,color:"#3b82f6",fontWeight:600,background:"#eff6ff",padding:"1px 6px",borderRadius:99 }}>✨ Auto-tagged</span>}
                      </div>
                      <div style={{ fontSize:11,color:"#94a3b8",marginTop:2,display:"flex",gap:10,flexWrap:"wrap" }}>
                        <span>{b.date}</span>
                        {pr&&<PracticeDot color={pr.color} name={pr.name}/>}
                        {b.type==="collection"&&<Badge label="💰 Collection" color="green"/>}
                        {b.type==="business"&&<Badge label={b.category||"Business"} color="teal"/>}
                        {b.type==="personal"&&<Badge label="Personal" color="gray"/>}
                        {exp&&<span>↔ {exp.vendor}</span>}
                      </div>
                    </div>

                    {/* Amount */}
                    <div style={{ fontSize:14,fontWeight:700,color:b.amount>0?"#166534":"#991b1b",flexShrink:0,textAlign:"right" }}>
                      {b.amount>0?"+":""}{fmtFull(b.amount)}
                    </div>

                    {/* Chevron */}
                    <div style={{ fontSize:12,color:"#94a3b8",flexShrink:0,transform:isOpen?"rotate(180deg)":"none",transition:"transform 0.15s" }}>▾</div>
                  </div>

                  {/* Expanded inline editor */}
                  {isOpen&&(
                    <div style={{ padding:"16px 20px 20px",borderBottom:"1px solid #f1f5f9",borderLeft:"3px solid "+borderColor,background:"#f8fafc" }}>
                      <div style={{ display:"flex",gap:14,flexWrap:"wrap",alignItems:"flex-start" }}>

                        {/* Transaction type */}
                        <div style={{ minWidth:180 }}>
                          <div style={{ fontSize:11,fontWeight:600,color:"#64748b",marginBottom:6,textTransform:"uppercase",letterSpacing:"0.05em" }}>Type</div>
                          <div style={{ display:"flex",flexDirection:"column",gap:5 }}>
                            {[
                              {v:"collection", l:"💰 Pay deposit"},
                              {v:"business",   l:"🏢 Business expense"},
                              {v:"personal",   l:"Personal"},
                            ].map(({v,l})=>(
                              <label key={v} style={{ display:"flex",alignItems:"center",gap:8,cursor:"pointer",fontSize:13,color:b.type===v?"#0F6E56":"#475569",fontWeight:b.type===v?600:400 }}>
                                <input type="radio" name={"type-"+b.id} value={v} checked={b.type===v}
                                  onChange={()=>tagBank(b.id,{...b,type:v,reviewed:true})}
                                  style={{ accentColor:"#0F6E56" }}/>
                                {l}
                              </label>
                            ))}
                          </div>
                        </div>

                        {/* Practice — only for deposits */}
                        {b.type==="collection"&&(
                          <div style={{ minWidth:160 }}>
                            <div style={{ fontSize:11,fontWeight:600,color:"#64748b",marginBottom:6,textTransform:"uppercase",letterSpacing:"0.05em" }}>Practice</div>
                            <select value={b.practiceId||""}
                              onChange={e=>tagBank(b.id,{...b,practiceId:e.target.value,type:"collection",reviewed:true})}
                              style={{ width:"100%",padding:"7px 10px",border:"1px solid #e2e8f0",borderRadius:7,fontSize:13,color:"#1e293b",background:"#fff" }}>
                              <option value="">— select —</option>
                              {practices.map(p=><option key={p.id} value={p.id}>{p.name}</option>)}
                            </select>
                          </div>
                        )}

                        {/* Category — only for expenses */}
                        {b.type==="business"&&(
                          <div style={{ minWidth:200 }}>
                            <div style={{ fontSize:11,fontWeight:600,color:"#64748b",marginBottom:6,textTransform:"uppercase",letterSpacing:"0.05em" }}>Category</div>
                            <select value={b.category||""}
                              onChange={e=>{
                                const cat=getCategory(e.target.value);
                                tagBank(b.id,{...b,category:cat.label,taxDeductible:cat.deductible,deductibleFraction:cat.fraction,corpExpense:agreement.isCorp&&cat.deductible,reviewed:true});
                              }}
                              style={{ width:"100%",padding:"7px 10px",border:"1px solid #e2e8f0",borderRadius:7,fontSize:13,color:"#1e293b",background:"#fff" }}>
                              <option value="">— select —</option>
                              {EXPENSE_CAT_LABELS.map(c=><option key={c} value={c}>{c}</option>)}
                            </select>
                            {b.category&&(()=>{
                              const cat=getCategory(b.category);
                              return cat ? <div style={{ fontSize:11,color:cat.deductible?"#166534":"#991b1b",marginTop:5,lineHeight:1.4 }}>{cat.note}</div> : null;
                            })()}
                          </div>
                        )}

                        {/* Notes */}
                        <div style={{ flex:1,minWidth:160 }}>
                          <div style={{ fontSize:11,fontWeight:600,color:"#64748b",marginBottom:6,textTransform:"uppercase",letterSpacing:"0.05em" }}>Notes</div>
                          <input
                            placeholder="Add a note for your accountant…"
                            defaultValue={b.notes||""}
                            onBlur={e=>setBanks(bk=>bk.map(x=>x.id===b.id?{...x,notes:e.target.value}:x))}
                            style={{ width:"100%",padding:"7px 10px",border:"1px solid #e2e8f0",borderRadius:7,fontSize:13,color:"#1e293b",boxSizing:"border-box" }}
                          />
                        </div>

                        {/* Receipt */}
                        {b.amount<0&&(
                          <div style={{ minWidth:160 }}>
                            <div style={{ fontSize:11,fontWeight:600,color:"#64748b",marginBottom:6,textTransform:"uppercase",letterSpacing:"0.05em" }}>Receipt</div>
                            {b.receipt ? (
                              <div style={{ display:"flex",alignItems:"center",gap:6 }}>
                                <span style={{ fontSize:12,color:"#166534",fontWeight:600 }}>✓ On file</span>
                                <Btn size="sm" variant="ghost" onClick={()=>setBanks(bk=>bk.map(x=>x.id===b.id?{...x,receipt:null}:x))}>Remove</Btn>
                              </div>
                            ) : (
                              <Btn size="sm" variant="secondary" onClick={()=>setScanningFor(b.id)}>📷 Scan / upload</Btn>
                            )}
                            {!b.receipt&&b.type==="business"&&b.taxDeductible&&(
                              <div style={{ fontSize:10,color:"#f59e0b",marginTop:4 }}>⚠ No receipt — CRA may ask</div>
                            )}
                          </div>
                        )}
                      </div>

                      {/* Action bar */}
                      <div style={{ display:"flex",gap:8,marginTop:14,alignItems:"center",flexWrap:"wrap" }}>
                        <Btn size="sm" onClick={()=>{ tagBank(b.id,{...b,reviewed:true,userTagged:true}); setExpandedId(null); }}>
                          ✓ Mark reviewed
                        </Btn>
                        {!pendingRule&&(
                          <Btn size="sm" variant="secondary"
                            onClick={()=>setPendingRule({txId:b.id,description:b.description,updates:{type:b.type,practiceId:b.practiceId,category:b.category,taxDeductible:b.taxDeductible,deductibleFraction:b.deductibleFraction,corpExpense:b.corpExpense}})}>
                            + Create rule from this
                          </Btn>
                        )}
                        {pendingRule?.txId===b.id&&(
                          <div style={{ display:"flex",alignItems:"center",gap:8,background:"#eff6ff",padding:"6px 12px",borderRadius:8,border:"1px solid #bfdbfe" }}>
                            <span style={{ fontSize:12,color:"#1e40af" }}>✨ Create rule for <strong>"{ruleFromTag(pendingRule.description,pendingRule.updates).matchText}"</strong>?</span>
                            <Btn size="sm" onClick={()=>{ addRule({...ruleFromTag(pendingRule.description,pendingRule.updates)}); setPendingRule(null); }}>Yes</Btn>
                            <Btn size="sm" variant="ghost" onClick={()=>setPendingRule(null)}>No</Btn>
                          </div>
                        )}
                        <div style={{ marginLeft:"auto" }}>
                          <Btn size="sm" variant="ghost"
                            onClick={()=>{ setBanks(bk=>bk.map(x=>x.id===b.id?{...x,type:"review",userTagged:false,autoTagged:false,reviewed:false,matchedRule:null}:x)); setExpandedId(null); }}>
                            Clear tag
                          </Btn>
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </Card>
      )}

      {/* Deductibles — filtered view of all deductible bank transactions */}
      {(sub==="all"||sub==="deductibles")&&(()=>{
        const deductible = banks.filter(b=>b.type==="business"&&b.taxDeductible);
        const total      = deductible.reduce((s,b)=>s+Math.abs(b.amount)*(b.deductibleFraction??1),0);
        const withReceipt  = deductible.filter(b=>b.receipt).length;
        const missingReceipt = deductible.filter(b=>!b.receipt);

        return(
          <div style={{ display:"flex",flexDirection:"column",gap:14 }}>
            {/* Summary strip */}
            <div style={{ display:"flex",gap:14,flexWrap:"wrap" }}>
              <StatCard label="Total deductible" value={fmt(total)} sub={deductible.length+" transactions"} color="#1e293b"/>
              <StatCard label="Receipts on file" value={withReceipt+"/"+deductible.length} sub={missingReceipt.length>0?missingReceipt.length+" missing":"All receipts filed ✓"} color="#1e293b"/>
            </div>

            {/* Missing receipt alert */}
            {missingReceipt.length>0&&(
              <div style={{ background:"#fffbeb",border:"1px solid #fde68a",borderRadius:10,padding:"12px 16px" }}>
                <div style={{ fontSize:13,fontWeight:600,color:"#92400e",marginBottom:4 }}>⚠ {missingReceipt.length} deductible transaction{missingReceipt.length!==1?"s":""} missing a receipt</div>
                <div style={{ fontSize:12,color:"#b45309" }}>CRA requires receipts for business expenses. Scan or upload them by clicking each transaction below.</div>
              </div>
            )}

            {/* Deductibles table */}
            <Card style={{ padding:0,overflow:"hidden" }}>
              {deductible.length===0 ? (
                <div style={{ padding:"32px 20px",textAlign:"center",color:"#94a3b8",fontSize:13 }}>
                  No deductible transactions yet — tag business expenses in the feed above.
                </div>
              ) : (
                deductible.sort((a,b)=>b.date.localeCompare(a.date)).map((b,i)=>{
                  const isOpen = expandedId===b.id;
                  return(
                    <div key={b.id}>
                      <div onClick={()=>setExpandedId(isOpen?null:b.id)}
                        style={{ display:"flex",alignItems:"center",gap:12,padding:"12px 20px",
                          borderBottom:isOpen?"none":"1px solid #f1f5f9",
                          borderLeft:"3px solid "+(b.receipt?"#e2e8f0":"#f59e0b"),
                          background:isOpen?"#f8fafc":i%2===0?"#fff":"#fafafa",cursor:"pointer" }}>
                        <div style={{ fontSize:16 }}>{b.receipt?"📷":"📄"}</div>
                        <div style={{ flex:1,minWidth:0 }}>
                          <div style={{ fontSize:13,fontWeight:500,color:"#1e293b" }}>{b.description}</div>
                          <div style={{ fontSize:11,color:"#94a3b8",marginTop:2,display:"flex",gap:8,flexWrap:"wrap" }}>
                            <span>{b.date}</span>
                            <Badge label={b.category||"Business"} color="teal"/>
                            {(b.deductibleFraction??1)<1&&<Badge label="50% rule" color="amber"/>}
                            {b.manual&&<Badge label="Manual" color="gray"/>}
                            {b.notes&&<span style={{ fontStyle:"italic" }}>"{b.notes}"</span>}
                          </div>
                        </div>
                        <div style={{ textAlign:"right",flexShrink:0 }}>
                          <div style={{ fontSize:14,fontWeight:700,color:"#1e293b" }}>{fmt(Math.abs(b.amount)*(b.deductibleFraction??1))}</div>
                          {(b.deductibleFraction??1)<1&&<div style={{ fontSize:10,color:"#94a3b8" }}>of {fmt(Math.abs(b.amount))} total</div>}
                        </div>
                        <div style={{ fontSize:12,color:"#94a3b8",flexShrink:0 }}>▾</div>
                      </div>
                      {isOpen&&(
                        <div style={{ padding:"14px 20px",borderBottom:"1px solid #f1f5f9",borderLeft:"3px solid "+(b.receipt?"#e2e8f0":"#f59e0b"),background:"#f8fafc" }}>
                          <div style={{ display:"flex",gap:14,alignItems:"flex-start",flexWrap:"wrap" }}>
                            <div style={{ flex:1 }}>
                              <div style={{ fontSize:12,color:"#64748b",marginBottom:4 }}>
                                {getCategory(b.category||"Other")?.note||""}
                              </div>
                              {b.notes&&<div style={{ fontSize:12,color:"#1e293b",fontStyle:"italic" }}>"{b.notes}"</div>}
                            </div>
                            <div>
                              {b.receipt ? (
                                <div style={{ display:"flex",alignItems:"center",gap:8 }}>
                                  <span style={{ fontSize:13,color:"#166534",fontWeight:600 }}>✓ Receipt on file</span>
                                  <Btn size="sm" variant="ghost" onClick={()=>setBanks(bk=>bk.map(x=>x.id===b.id?{...x,receipt:null}:x))}>Remove</Btn>
                                </div>
                              ) : (
                                <div>
                                  <Btn size="sm" onClick={()=>setScanningFor(b.id)}>📷 Scan / upload receipt</Btn>
                                  <div style={{ fontSize:10,color:"#92400e",marginTop:4 }}>Required for CRA audit protection</div>
                                </div>
                              )}
                            </div>
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })
              )}
            </Card>

            <div style={{ fontSize:11,color:"#94a3b8",fontStyle:"italic",textAlign:"center" }}>
              Estimates based on your input — not tax advice. Confirm with your accountant (CPA/CA) before filing.
            </div>
          </div>
        );
      })()}

      {(sub==="all"||sub==="reconcile")&&(
        <div style={{ display:"flex",flexDirection:"column",gap:14 }}>
          <div style={{ background:"#f0fdf4",border:"1px solid #bbf7d0",borderRadius:10,padding:"12px 16px",fontSize:12,color:"#166634" }}>
            <strong>How reconciliation works:</strong> Your production is logged from day sheets. Collections are deposits tagged to each practice from the bank feed. The implied collection rate (deposits ÷ production) should be stable month over month — a significant drop is a signal to request a collections statement from the practice.
          </div>
          {practices.map(pr=>{
            const prProd  = production.filter(r=>r.practiceId===pr.id).reduce((s,r)=>s+r.production,0);
            const prDeps  = banks.filter(b=>b.type==="collection"&&b.practiceId===pr.id).reduce((s,b)=>s+b.amount,0);
            const prLab   = pr.deductsLabFees ? production.filter(r=>r.practiceId===pr.id).reduce((s,r)=>s+(r.labFees||0),0) : 0;
            const prExpPay= Math.max(0, prDeps - prLab) * (pr.pct/100);
            const rate    = prProd>0 ? (prDeps/prProd)*100 : null;
            const rateLow = rate!==null && rate < 70;
            return(<Card key={pr.id} style={{ borderTop:"3px solid "+pr.color }}>
              <div style={{ display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:16 }}>
                <div>
                  <div style={{ fontSize:14,fontWeight:700,color:"#1e293b" }}>{pr.name}</div>
                  <div style={{ fontSize:12,color:"#94a3b8" }}>{pr.pct}% of {pr.basis}{pr.deductsLabFees?" · lab fees deducted first":""}</div>
                </div>
                {rateLow&&<span>⚠️</span>}
              </div>
              <div className="dt-grid-cols" style={{ display:"grid",gridTemplateColumns:"1fr 1fr 1fr 1fr",gap:12,marginBottom:12 }}>
                <div style={{ background:"#f8fafc",borderRadius:8,padding:14 }}>
                  <div style={{ fontSize:11,color:"#94a3b8",marginBottom:4 }}>Production logged</div>
                  <div style={{ fontSize:20,fontWeight:800,color:"#1e293b" }}>{fmt(prProd)}</div>
                </div>
                <div style={{ background:"#f8fafc",borderRadius:8,padding:14 }}>
                  <div style={{ fontSize:11,color:"#94a3b8",marginBottom:4 }}>Deposits received</div>
                  <div style={{ fontSize:20,fontWeight:800,color:"#1e293b" }}>{fmt(prDeps)}</div>
                </div>
                <div style={{ background: rateLow?"#fee2e2":"#f8fafc",borderRadius:8,padding:14 }}>
                  <div style={{ fontSize:11,color:"#94a3b8",marginBottom:4 }}>Implied collection rate</div>
                  <div style={{ fontSize:20,fontWeight:800,color:rateLow?"#991b1b":"#1e293b" }}>
                    {rate!==null?rate.toFixed(0)+"%":"—"}
                  </div>
                </div>
                <div style={{ background:"#f8fafc",borderRadius:8,padding:14 }}>
                  <div style={{ fontSize:11,color:"#94a3b8",marginBottom:4 }}>Expected pay{prLab>0?" (after lab)":""}</div>
                  <div style={{ fontSize:20,fontWeight:800,color:"#1e293b" }}>{fmt(prExpPay)}</div>
                </div>
              </div>
              {prLab>0&&<div style={{ fontSize:12,color:"#94a3b8",marginBottom:10 }}>Lab fees deducted before %: {fmt(prLab)}</div>}
              {rateLow&&(
                <div style={{ background:"#fef3c7",border:"1px solid #fde68a",borderRadius:8,padding:"10px 14px",fontSize:12,color:"#92400e" }}>
                  ⚠️ Your implied collection rate is {rate.toFixed(0)}% — lower than the typical 80–95% range. This could mean deposits are lagging (normal with insurance), or the practice may be applying adjustments that reduce your base. Consider requesting a monthly collections statement from {pr.name} — you're entitled to know what was collected on your procedures.
                </div>
              )}
            </Card>);
          })}
        </div>
      )}
    </div>
  );
};

// ── Settings Tab ──────────────────────────────────────────────────────────────
// Simulated Plaid-style account connect modal
const MOCK_INSTITUTIONS = [
  { id:"td",   name:"TD Bank",         logo:"🏦", accounts:[
    { id:"td-chq",  name:"TD Chequing",      mask:"4821", type:"depository" },
    { id:"td-sav",  name:"TD Savings",       mask:"3302", type:"depository" },
    { id:"td-visa", name:"TD Visa",          mask:"7734", type:"credit"     },
  ]},
  { id:"rbc",  name:"RBC Royal Bank",   logo:"🏦", accounts:[
    { id:"rbc-chq",  name:"RBC Chequing",    mask:"2241", type:"depository" },
    { id:"rbc-visa", name:"RBC Visa",        mask:"5519", type:"credit"     },
  ]},
  { id:"bmo",  name:"BMO",              logo:"🏦", accounts:[
    { id:"bmo-chq",  name:"BMO Chequing",    mask:"8843", type:"depository" },
    { id:"bmo-mc",   name:"BMO Mastercard",  mask:"1127", type:"credit"     },
  ]},
  { id:"cibc", name:"CIBC",             logo:"🏦", accounts:[
    { id:"cibc-chq", name:"CIBC Chequing",   mask:"6631", type:"depository" },
    { id:"cibc-visa","name":"CIBC Visa",      mask:"9904", type:"credit"     },
  ]},
];

const ACCOUNT_LABELS = ["Corp bank","Corp credit card","Personal — skip"];

const PlaidModal = ({ onConnect, onClose }) => {
  const [step, setStep] = useState("institution"); // institution | accounts | label | done
  const [institution, setInstitution] = useState(null);
  const [selected, setSelected] = useState({});  // accountId → true/false
  const [labels, setLabels] = useState({});       // accountId → label string
  const [connecting, setConnecting] = useState(false);

  const toggleAccount = (id) => setSelected(s=>({...s,[id]:!s[id]}));
  const selectedAccounts = institution?.accounts.filter(a=>selected[a.id])||[];

  const connect = () => {
    setConnecting(true);
    setTimeout(()=>{
      const connected = selectedAccounts.map(a=>({
        ...a,
        institution: institution.name,
        label: labels[a.id]||ACCOUNT_LABELS[a.type==="credit"?1:0],
        connected: true,
        lastSync: new Date().toISOString().slice(0,10),
      }));
      onConnect(connected);
      setStep("done");
      setConnecting(false);
    }, 1400);
  };

  return (
    <div className="dt-modal-overlay" style={{ position:"fixed",inset:0,background:"rgba(0,0,0,0.45)",display:"flex",alignItems:"center",justifyContent:"center",zIndex:1000 }}>
      <Card className="dt-modal-card" style={{ width:460,padding:28,overflowY:"auto",maxHeight:"90vh" }}>
        {step==="done" ? (
          <div style={{ textAlign:"center",padding:"24px 0" }}>
            <div style={{ fontSize:36,marginBottom:12 }}>✅</div>
            <div style={{ fontSize:16,fontWeight:700,color:"#1e293b",marginBottom:6 }}>Accounts connected</div>
            <div style={{ fontSize:13,color:"#64748b",marginBottom:20 }}>Your bank feed will update automatically.</div>
            <Btn onClick={onClose}>Done</Btn>
          </div>
        ) : (
          <>
            <div style={{ display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:20 }}>
              <div style={{ fontSize:16,fontWeight:700,color:"#1e293b" }}>
                {step==="institution"?"Select your bank":step==="accounts"?"Select accounts":"Label accounts"}
              </div>
              <Btn variant="ghost" size="sm" onClick={onClose}>Close</Btn>
            </div>

            {step==="institution"&&(
              <div style={{ display:"flex",flexDirection:"column",gap:10 }}>
                <div style={{ fontSize:13,color:"#64748b",marginBottom:6 }}>Connect your bank or credit card to automatically pull in deposits and expenses.</div>
                {MOCK_INSTITUTIONS.map(inst=>(
                  <div key={inst.id} onClick={()=>{ setInstitution(inst); setStep("accounts"); }}
                    style={{ display:"flex",alignItems:"center",gap:12,padding:"14px 16px",border:"1px solid #e2e8f0",borderRadius:10,cursor:"pointer",background:"#fff",transition:"border 0.15s" }}
                    onMouseEnter={e=>e.currentTarget.style.borderColor="#0F6E56"}
                    onMouseLeave={e=>e.currentTarget.style.borderColor="#e2e8f0"}>
                    <span style={{ fontSize:22 }}>{inst.logo}</span>
                    <span style={{ fontWeight:600,color:"#1e293b",fontSize:14 }}>{inst.name}</span>
                    <span style={{ marginLeft:"auto",color:"#94a3b8",fontSize:13 }}>→</span>
                  </div>
                ))}
                <div style={{ fontSize:11,color:"#94a3b8",marginTop:8,textAlign:"center" }}>
                  Powered by Plaid · Bank-level 256-bit encryption · Read-only access
                </div>
              </div>
            )}

            {step==="accounts"&&institution&&(
              <div style={{ display:"flex",flexDirection:"column",gap:10 }}>
                <div style={{ fontSize:13,color:"#64748b",marginBottom:6 }}>Select which accounts to connect. You can add or remove accounts later in Settings.</div>
                {institution.accounts.map(acc=>(
                  <label key={acc.id} style={{ display:"flex",alignItems:"center",gap:12,padding:"14px 16px",border:"1px solid "+(selected[acc.id]?"#0F6E56":"#e2e8f0"),borderRadius:10,cursor:"pointer",background:selected[acc.id]?"#f0fdf4":"#fff" }}>
                    <input type="checkbox" checked={!!selected[acc.id]} onChange={()=>toggleAccount(acc.id)} style={{ width:18,height:18 }} />
                    <div style={{ flex:1 }}>
                      <div style={{ fontWeight:600,color:"#1e293b",fontSize:13 }}>{acc.name}</div>
                      <div style={{ fontSize:11,color:"#94a3b8" }}>···{acc.mask} · {acc.type==="credit"?"Credit card":"Bank account"}</div>
                    </div>
                  </label>
                ))}
                <div style={{ display:"flex",gap:10,marginTop:8,justifyContent:"flex-end" }}>
                  <Btn variant="secondary" onClick={()=>setStep("institution")}>Back</Btn>
                  <Btn onClick={()=>setStep("label")} style={{ opacity:selectedAccounts.length?1:0.4 }} disabled={!selectedAccounts.length}>Next</Btn>
                </div>
              </div>
            )}

            {step==="label"&&(
              <div style={{ display:"flex",flexDirection:"column",gap:12 }}>
                <div style={{ fontSize:13,color:"#64748b",marginBottom:6 }}>Tell us how each account should be used — this determines how transactions are categorized.</div>
                {selectedAccounts.map(acc=>(
                  <div key={acc.id} style={{ background:"#f8fafc",border:"1px solid #e2e8f0",borderRadius:10,padding:"12px 14px" }}>
                    <div style={{ fontWeight:600,color:"#1e293b",fontSize:13,marginBottom:8 }}>{acc.name} ···{acc.mask}</div>
                    <div style={{ display:"flex",flexDirection:"column",gap:6 }}>
                      {ACCOUNT_LABELS.map(lbl=>(
                        <label key={lbl} style={{ display:"flex",alignItems:"center",gap:8,cursor:"pointer",fontSize:13,color:"#475569" }}>
                          <input type="radio" name={acc.id} value={lbl}
                            checked={(labels[acc.id]||ACCOUNT_LABELS[acc.type==="credit"?1:0])===lbl}
                            onChange={()=>setLabels(l=>({...l,[acc.id]:lbl}))} style={{ width:16,height:16 }} />
                          {lbl}
                          {lbl==="Personal — skip"&&<span style={{ fontSize:11,color:"#94a3b8" }}>(transactions ignored)</span>}
                        </label>
                      ))}
                    </div>
                  </div>
                ))}
                <div style={{ display:"flex",gap:10,marginTop:8,justifyContent:"flex-end" }}>
                  <Btn variant="secondary" onClick={()=>setStep("accounts")}>Back</Btn>
                  <Btn onClick={connect} style={{ opacity:connecting?0.6:1 }}>
                    {connecting?"Connecting…":"Connect accounts"}
                  </Btn>
                </div>
              </div>
            )}
          </>
        )}
      </Card>
    </div>
  );
};

// ── Rules Manager ──────────────────────────────────────────────────────────────
const EMPTY_RULE = { matchText:"", matchType:"contains", type:"business", practiceId:null, category:"Supplies", taxDeductible:true, deductibleFraction:1.0, corpExpense:false };

const RuleFormModal = ({ rule, practices, onSave, onClose }) => {
  const [form, setForm] = useState(rule||{...EMPTY_RULE,id:newId(),appliedCount:0,createdFrom:"manual"});
  const set = (k,v) => setForm(f=>({...f,[k]:v}));
  const isDeposit = form.type==="collection";

  return(
    <div className="dt-modal-overlay" style={{ position:"fixed",inset:0,background:"rgba(0,0,0,0.45)",display:"flex",alignItems:"center",justifyContent:"center",zIndex:1000 }}>
      <Card className="dt-modal-card" style={{ width:500,padding:28,overflowY:"auto",maxHeight:"90vh" }}>
        <div style={{ display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:20 }}>
          <div style={{ fontSize:16,fontWeight:700,color:"#1e293b" }}>{rule?"Edit rule":"New rule"}</div>
          <Btn variant="ghost" size="sm" onClick={onClose}>Close</Btn>
        </div>
        <div style={{ display:"flex",flexDirection:"column",gap:14 }}>
          <div>
            <label style={{ fontSize:12,fontWeight:500,color:"#475569",display:"block",marginBottom:6 }}>When description</label>
            <div style={{ display:"flex",gap:8 }}>
              <select value={form.matchType} onChange={e=>set("matchType",e.target.value)}
                style={{ padding:"8px 10px",border:"1px solid #e2e8f0",borderRadius:7,fontSize:13,color:"#1e293b",background:"#fff" }}>
                <option value="contains">contains</option>
                <option value="starts_with">starts with</option>
                <option value="equals">exactly equals</option>
              </select>
              <input value={form.matchText} onChange={e=>set("matchText",e.target.value)}
                placeholder='e.g. "TDIC" or "PATTERSON"'
                style={{ flex:1,padding:"8px 12px",border:"1px solid #e2e8f0",borderRadius:7,fontSize:13,color:"#1e293b" }}/>
            </div>
            <div style={{ fontSize:11,color:"#94a3b8",marginTop:4 }}>Case-insensitive. Be specific enough to avoid false matches.</div>
          </div>

          <div>
            <label style={{ fontSize:12,fontWeight:500,color:"#475569",display:"block",marginBottom:6 }}>Transaction type</label>
            <div style={{ display:"flex",gap:8 }}>
              {[["collection","💰 Pay deposit"],["business","🏢 Business expense"],["personal","Personal"]].map(([v,l])=>(
                <button key={v} onClick={()=>set("type",v)}
                  style={{ flex:1,padding:"8px",border:"1px solid "+(form.type===v?"#0F6E56":"#e2e8f0"),borderRadius:8,fontSize:12,fontWeight:600,cursor:"pointer",background:form.type===v?"#f0fdf4":"#fff",color:form.type===v?"#0F6E56":"#64748b" }}>{l}</button>
              ))}
            </div>
          </div>

          {form.type==="collection"&&(
            <Sel label="Practice" value={form.practiceId||""} onChange={e=>set("practiceId",e.target.value)}>
              <option value="">— not specified —</option>
              {practices.map(p=><option key={p.id} value={p.id}>{p.name}</option>)}
            </Sel>
          )}

          {form.type==="business"&&(
            <>
              <Sel label="Category" value={form.category||"Supplies"} onChange={e=>{
                const cat=getCategory(e.target.value);
                set("category",e.target.value);
                set("taxDeductible",cat.deductible);
                set("deductibleFraction",cat.fraction);
              }}>
                {EXPENSE_CAT_LABELS.map(c=><option key={c} value={c}>{c}</option>)}
              </Sel>
              <div style={{ background:form.taxDeductible?"#f0fdf4":"#fef2f2",border:"1px solid "+(form.taxDeductible?"#bbf7d0":"#fecaca"),borderRadius:8,padding:"10px 14px",fontSize:12,color:form.taxDeductible?"#166534":"#991b1b" }}>
                {getCategory(form.category||"Supplies")?.note||""}
                {(form.deductibleFraction??1)<1&&<div style={{ fontWeight:600,marginTop:4 }}>50% deductibility rule applies automatically.</div>}
              </div>
            </>
          )}

          <div style={{ display:"flex",gap:10,justifyContent:"flex-end",marginTop:8 }}>
            <Btn variant="secondary" onClick={onClose}>Cancel</Btn>
            <Btn onClick={()=>{ if(!form.matchText.trim()) return; onSave(form); }} disabled={!form.matchText.trim()}>Save rule</Btn>
          </div>
        </div>
      </Card>
    </div>
  );
};

const SettingsTab = ({ agreement, setAgreement, practices, setPractices, isMobile, connectedAccounts, setConnectedAccounts, activeSection, bankRules, addRule, updateRule, deleteRule }) => {
  const [showModal, setShowModal]       = useState(false);
  const [editPractice, setEditPractice] = useState(null);
  const [showPlaid, setShowPlaid]       = useState(false);
  const [showRuleForm, setShowRuleForm] = useState(false);
  const [editRule, setEditRule]         = useState(null);
  const refProfile   = useRef();
  const refAccounts  = useRef();
  const refPractices = useRef();
  const refRules     = useRef();
  const refCorp      = useRef();
  const refs = { profile: refProfile, accounts: refAccounts, practices: refPractices, rules: refRules, corp: refCorp };

  useEffect(()=>{
    if(activeSection && refs[activeSection]?.current) {
      setTimeout(()=>refs[activeSection].current.scrollIntoView({ behavior:"smooth", block:"start" }), 100);
    }
  }, [activeSection]);

  const savePractice = (form) => {
    if(editPractice) { setPractices(p=>p.map(x=>x.id===editPractice.id?{...form,id:x.id}:x)); }
    else { setPractices(p=>[...p,{...form,id:newId()}]); }
    setEditPractice(null);
  };

  const removeAccount = (id) => setConnectedAccounts(a=>a.filter(x=>x.id!==id));

  return (
    <div style={{ display:"flex",flexDirection:"column",gap:20 }}>
      {(showModal||editPractice)&&<PracticeModal practice={editPractice} onSave={savePractice} onClose={()=>{ setShowModal(false); setEditPractice(null); }}/>}
      {showPlaid&&<PlaidModal onConnect={accs=>setConnectedAccounts(a=>[...a,...accs.filter(na=>!a.find(x=>x.id===na.id))])} onClose={()=>setShowPlaid(false)} />}
      {(showRuleForm||editRule)&&<RuleFormModal
        rule={editRule}
        practices={practices}
        onSave={r=>{ editRule ? updateRule(r.id,r) : addRule(r); setShowRuleForm(false); setEditRule(null); }}
        onClose={()=>{ setShowRuleForm(false); setEditRule(null); }}
      />}

      <Card ref={refs.profile} style={{ scrollMarginTop:80, outline: activeSection==="profile"?"2px solid #0F6E56":"none", outlineOffset:2 }}>
        <div style={{ fontSize:15,fontWeight:700,color:"#1e293b",marginBottom:18 }}>Profile</div>
        <div className="dt-grid-cols" style={{ display:"grid",gridTemplateColumns:"1fr 1fr",gap:14 }}>
          <Input label="Your name" value={agreement.name||""} onChange={e=>setAgreement(a=>({...a,name:e.target.value}))} placeholder="Dr. Jane Smith" />
          <Input label="Corporate name (appears on P&L)" value={agreement.corpName||""} onChange={e=>setAgreement(a=>({...a,corpName:e.target.value}))} placeholder="e.g. Smith Dental Prof. Corp." />
        </div>
      </Card>

      {/* Connected accounts */}
      <Card ref={refs.accounts} style={{ scrollMarginTop:80, outline: activeSection==="accounts"?"2px solid #0F6E56":"none", outlineOffset:2 }}>
        <div style={{ display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:16 }}>
          <div>
            <div style={{ fontSize:15,fontWeight:700,color:"#1e293b" }}>Connected accounts</div>
            <div style={{ fontSize:12,color:"#94a3b8",marginTop:2 }}>Bank and credit card feeds for automatic transaction sync</div>
          </div>
          <Btn onClick={()=>setShowPlaid(true)}>+ Connect account</Btn>
        </div>
        {!connectedAccounts.length ? (
          <div style={{ background:"#f8fafc",border:"1px dashed #e2e8f0",borderRadius:10,padding:"24px 20px",textAlign:"center" }}>
            <div style={{ fontSize:28,marginBottom:8 }}>🏦</div>
            <div style={{ fontWeight:600,color:"#1e293b",fontSize:14,marginBottom:4 }}>No accounts connected yet</div>
            <div style={{ fontSize:12,color:"#94a3b8",marginBottom:16 }}>Connect your bank and credit card to automatically pull in deposits and expenses.</div>
            <Btn onClick={()=>setShowPlaid(true)}>Connect your bank</Btn>
          </div>
        ) : (
          <div style={{ display:"flex",flexDirection:"column",gap:10 }}>
            {connectedAccounts.map(acc=>(
              <div key={acc.id} style={{ display:"flex",alignItems:"center",gap:12,padding:"12px 16px",border:"1px solid #e2e8f0",borderRadius:10,background:"#fafafa" }}>
                <div style={{ width:36,height:36,background:acc.type==="credit"?"#ede9fe":"#E1F5EE",borderRadius:8,display:"flex",alignItems:"center",justifyContent:"center",fontSize:18,flexShrink:0 }}>
                  {acc.type==="credit"?"💳":"🏦"}
                </div>
                <div style={{ flex:1,minWidth:0 }}>
                  <div style={{ fontWeight:600,color:"#1e293b",fontSize:13 }}>{acc.name} ···{acc.mask}</div>
                  <div style={{ fontSize:11,color:"#94a3b8",marginTop:2 }}>{acc.institution} · Last sync: {acc.lastSync}</div>
                </div>
                <div style={{ display:"flex",alignItems:"center",gap:6,flexShrink:0 }}>
                  <Badge label={acc.label} color={acc.label==="Corp bank"?"teal":acc.label==="Corp credit card"?"purple":"gray"} />
                  <Badge label="✓ Live" color="green" />
                  <Btn variant="danger" size="sm" onClick={()=>removeAccount(acc.id)}>Disconnect</Btn>
                </div>
              </div>
            ))}
            <div style={{ fontSize:11,color:"#94a3b8",marginTop:4,paddingLeft:4 }}>
              Read-only access · Powered by Plaid · Transactions sync automatically every few hours
            </div>
          </div>
        )}
      </Card>

      <Card ref={refs.practices} style={{ scrollMarginTop:80, outline: activeSection==="practices"?"2px solid #0F6E56":"none", outlineOffset:2 }}>
        <div style={{ display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:18 }}>
          <div style={{ fontSize:15,fontWeight:700,color:"#1e293b" }}>Practices</div>
          <Btn onClick={()=>setShowModal(true)}>+ Add practice</Btn>
        </div>
        {!practices.length&&<div style={{ textAlign:"center",padding:"32px 0",color:"#94a3b8",fontSize:13 }}>No practices yet — add your first one above.</div>}
        <div style={{ display:"flex",flexDirection:"column",gap:10 }}>
          {practices.map(pr=>(
            <div key={pr.id} style={{ display:"flex",justifyContent:"space-between",alignItems:"center",padding:"14px 16px",border:"1px solid #e2e8f0",borderRadius:10,borderLeft:"4px solid "+pr.color }}>
              <div>
                <div style={{ fontWeight:600,color:"#1e293b",fontSize:14 }}>{pr.name}</div>
                <div style={{ fontSize:12,color:"#94a3b8",marginTop:2 }}>{pr.address}, {pr.city} {pr.province} {pr.postalCode}</div>
                <div style={{ fontSize:12,color:"#64748b",marginTop:4 }}>{pr.pct}% of {pr.basis}{pr.deductsLabFees?" · Lab fees deducted before %":""}{pr.guarantee?" · Guarantee: "+fmt(pr.guarantee):""}</div>
              </div>
              <div style={{ display:"flex",gap:8 }}>
                <Btn variant="ghost" size="sm" onClick={()=>setEditPractice(pr)}>Edit</Btn>
                <Btn variant="danger" size="sm" onClick={()=>setPractices(p=>p.filter(x=>x.id!==pr.id))}>Remove</Btn>
              </div>
            </div>
          ))}
        </div>
      </Card>

      {/* Bank Rules */}
      <Card ref={refRules} style={{ scrollMarginTop:80, outline: activeSection==="rules"?"2px solid #0F6E56":"none", outlineOffset:2 }}>
        <div style={{ display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:16 }}>
          <div>
            <div style={{ fontSize:15,fontWeight:700,color:"#1e293b" }}>Bank rules</div>
            <div style={{ fontSize:12,color:"#94a3b8",marginTop:2 }}>Auto-categorize transactions from recurring vendors</div>
          </div>
          <Btn onClick={()=>setShowRuleForm(true)}>+ Add rule</Btn>
        </div>
        {!bankRules?.length ? (
          <div style={{ background:"#f8fafc",border:"1px dashed #e2e8f0",borderRadius:10,padding:"20px",textAlign:"center",fontSize:13,color:"#94a3b8" }}>
            No rules yet — tag a transaction in the bank feed and tap "Create rule" to get started.
          </div>
        ) : (
          <div style={{ display:"flex",flexDirection:"column",gap:8 }}>
            {(bankRules||[]).map(rule=>{
              const pr = rule.practiceId ? practices.find(p=>p.id===rule.practiceId) : null;
              return(
                <div key={rule.id} style={{ display:"flex",alignItems:"center",gap:12,padding:"10px 14px",border:"1px solid #e2e8f0",borderRadius:9,background:"#fafafa" }}>
                  <div style={{ flex:1,minWidth:0 }}>
                    <div style={{ fontSize:13,fontWeight:600,color:"#1e293b" }}>
                      Description <span style={{ color:"#64748b",fontWeight:400 }}>{rule.matchType==="contains"?"contains":rule.matchType==="starts_with"?"starts with":"equals"}</span>{" "}
                      <span style={{ background:"#f1f5f9",padding:"1px 7px",borderRadius:5,fontFamily:"monospace",fontSize:12 }}>"{rule.matchText}"</span>
                    </div>
                    <div style={{ fontSize:11,color:"#94a3b8",marginTop:3,display:"flex",gap:8,flexWrap:"wrap" }}>
                      {rule.type==="collection"&&<span>💰 Pay deposit{pr?" → "+pr.name:""}</span>}
                      {rule.type==="business"&&<span>🏢 {rule.category}{rule.taxDeductible?" · Deductible":""}{(rule.deductibleFraction??1)<1?" (50%)":""}</span>}
                      {rule.type==="personal"&&<span>Personal</span>}
                      {rule.appliedCount>0&&<span>· Applied {rule.appliedCount}×</span>}
                      {rule.createdFrom==="auto"&&<Badge label="Auto-created" color="blue"/>}
                    </div>
                  </div>
                  <div style={{ display:"flex",gap:6,flexShrink:0 }}>
                    <Btn size="sm" variant="ghost" onClick={()=>{ setEditRule(rule); }}>Edit</Btn>
                    <Btn size="sm" variant="danger" onClick={()=>deleteRule(rule.id)}>Delete</Btn>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </Card>

      <Card>
        <div style={{ fontSize:15,fontWeight:700,color:"#1e293b",marginBottom:6 }}>Professional corp</div>
        <div style={{ fontSize:13,color:"#64748b",marginBottom:14 }}>Enable if you are incorporated and collections flow through your professional corporation.</div>
        <label style={{ display:"flex",alignItems:"center",gap:12,cursor:"pointer" }}>
          <input type="checkbox" checked={agreement.isCorp} onChange={e=>setAgreement(a=>({...a,isCorp:e.target.checked}))} style={{ width:20,height:20 }} />
          <div>
            <div style={{ fontSize:14,fontWeight:600,color:"#1e293b" }}>I operate through a professional corp (PC / PLLC)</div>
            <div style={{ fontSize:12,color:"#94a3b8" }}>Enables corp expense tracking and salary/dividend split estimation</div>
          </div>
        </label>
        {agreement.isCorp&&(
          <div className="dt-grid-cols" style={{ marginTop:16,display:"grid",gridTemplateColumns:"1fr 1fr",gap:14 }}>
            <Input label="Salary from corp (monthly, $)" type="number" value={agreement.salary||""} onChange={e=>setAgreement(a=>({...a,salary:+e.target.value}))} placeholder="0" />
            <Input label="Dividends from corp (annual, $)" type="number" value={agreement.dividends||""} onChange={e=>setAgreement(a=>({...a,dividends:+e.target.value}))} placeholder="0" />
            <div style={{ fontSize:11,color:"#94a3b8",gridColumn:"1 / -1",marginTop:-6 }}>Dividends are typically declared periodically (often annually) rather than monthly — enter your expected total for the year.</div>
          </div>
        )}
      </Card>
    </div>
  );
};

// ── Onboarding ────────────────────────────────────────────────────────────────
const DENTAL_SCHOOLS = [
  "University of Toronto — Faculty of Dentistry",
  "McGill University — Faculty of Dentistry",
  "Université de Montréal — Faculté de médecine dentaire",
  "Université Laval — Faculté de médecine dentaire",
  "Dalhousie University — Faculty of Dentistry",
  "University of Manitoba — College of Dentistry",
  "University of Saskatchewan — College of Dentistry",
  "University of Alberta — School of Dentistry",
  "University of British Columbia — Faculty of Dentistry",
  "Western University — Schulich Dentistry",
  "Other / International",
];

const PROVINCES_FULL = [
  // Canada
  { code:"AB", name:"Alberta",                college:"Alberta Dental Association and College (ADA&C)",          example:"ADA&C: 1234"    },
  { code:"BC", name:"British Columbia",        college:"College of Dental Surgeons of BC (CDSBC)",               example:"CDSBC: 6789"    },
  { code:"MB", name:"Manitoba",                college:"Manitoba Dental Association (MDA)",                      example:"MDA: 4321"      },
  { code:"NB", name:"New Brunswick",           college:"New Brunswick Dental Society (NBDS)",                    example:"NBDS: 0987"     },
  { code:"NL", name:"Newfoundland & Labrador", college:"Newfoundland & Labrador Dental Board (NLDB)",            example:"NLDB: 5678"     },
  { code:"NS", name:"Nova Scotia",             college:"Nova Scotia Dental Association (NSDA)",                  example:"NSDA: 3456"     },
  { code:"ON", name:"Ontario",                 college:"Royal College of Dental Surgeons of Ontario (RCDSO)",    example:"RCDSO: 12345"   },
  { code:"PE", name:"Prince Edward Island",    college:"PEI Dental Association",                                 example:"PEIDA: 111"     },
  { code:"QC", name:"Quebec",                  college:"Ordre des dentistes du Québec (ODQ)",                    example:"ODQ: 78901"     },
  { code:"SK", name:"Saskatchewan",            college:"College of Dental Surgeons of Saskatchewan (CDSS)",      example:"CDSS: 2345"     },
  { code:"NT", name:"Northwest Territories",   college:"NWT Dental Association",                                 example:"NWT: 001"       },
  { code:"NU", name:"Nunavut",                 college:"Nunavut Dental Association",                             example:"NU: 001"        },
  { code:"YT", name:"Yukon",                   college:"Yukon Dental Association",                               example:"YK: 001"        },
  // United States
  { code:"US-AL", name:"Alabama (US)",         college:"Alabama Board of Dental Examiners",                      example:"AL: 12345"      },
  { code:"US-AK", name:"Alaska (US)",          college:"Alaska Board of Dental Examiners",                      example:"AK: 12345"      },
  { code:"US-AZ", name:"Arizona (US)",         college:"Arizona State Board of Dental Examiners",               example:"AZ: 12345"      },
  { code:"US-CA", name:"California (US)",      college:"Dental Board of California",                            example:"CA: 12345"      },
  { code:"US-CO", name:"Colorado (US)",        college:"Colorado Dental Board",                                  example:"CO: 12345"      },
  { code:"US-FL", name:"Florida (US)",         college:"Florida Board of Dentistry",                            example:"FL: 12345"      },
  { code:"US-GA", name:"Georgia (US)",         college:"Georgia Board of Dentistry",                            example:"GA: 12345"      },
  { code:"US-IL", name:"Illinois (US)",        college:"Illinois State Dental Society",                         example:"IL: 12345"      },
  { code:"US-MA", name:"Massachusetts (US)",   college:"Massachusetts Board of Registration in Dentistry",      example:"MA: 12345"      },
  { code:"US-MI", name:"Michigan (US)",        college:"Michigan Board of Dentistry",                           example:"MI: 12345"      },
  { code:"US-MN", name:"Minnesota (US)",       college:"Minnesota Board of Dentistry",                          example:"MN: 12345"      },
  { code:"US-NJ", name:"New Jersey (US)",      college:"New Jersey State Board of Dentistry",                   example:"NJ: 12345"      },
  { code:"US-NY", name:"New York (US)",        college:"New York State Board of Dentistry",                     example:"NY: 12345"      },
  { code:"US-NC", name:"North Carolina (US)",  college:"North Carolina State Board of Dental Examiners",        example:"NC: 12345"      },
  { code:"US-OH", name:"Ohio (US)",            college:"Ohio State Dental Board",                               example:"OH: 12345"      },
  { code:"US-PA", name:"Pennsylvania (US)",    college:"Pennsylvania State Board of Dentistry",                 example:"PA: 12345"      },
  { code:"US-TX", name:"Texas (US)",           college:"Texas State Board of Dental Examiners",                 example:"TX: 12345"      },
  { code:"US-VA", name:"Virginia (US)",        college:"Virginia Board of Dentistry",                           example:"VA: 12345"      },
  { code:"US-WA", name:"Washington (US)",      college:"Washington State Dental Quality Assurance Commission",  example:"WA: 12345"      },
  { code:"US-OTHER", name:"Other US state",    college:"Your state dental board",                               example:"License: 12345" },
  // Other
  { code:"OTHER", name:"Other / International", college:"",                                                     example:"License: 12345" },
];

const GRADUATING_YEARS = Array.from({ length:40 }, (_,i)=>(new Date().getFullYear()-i).toString());

const OnboardingShell = ({ step, total, children }) => (
  <div style={{ minHeight:"100vh",background:"#f8fafc",display:"flex",alignItems:"center",justifyContent:"center",fontFamily:"system-ui,-apple-system,sans-serif",padding:"24px 16px" }}>
    <div style={{ width:"100%",maxWidth:480 }}>
      <div style={{ display:"flex",alignItems:"center",gap:10,marginBottom:32 }}>
        <div style={{ width:32,height:32,background:"#0F6E56",borderRadius:8,display:"flex",alignItems:"center",justifyContent:"center",color:"#fff",fontWeight:800,fontSize:15 }}>D</div>
        <div style={{ fontWeight:800,fontSize:16,color:"#1e293b" }}>DentaTrack</div>
      </div>
      {step>1&&step<total&&(
        <div style={{ display:"flex",gap:6,marginBottom:32 }}>
          {Array.from({length:total},(_,i)=>(
            <div key={i} style={{ flex:1,height:3,borderRadius:99,background:i+1<=step?"#0F6E56":"#e2e8f0",transition:"background 0.3s" }} />
          ))}
        </div>
      )}
      {children}
    </div>
  </div>
);

const Onboarding = ({ onComplete }) => {
  const [step, setStep] = useState(1);
  const TOTAL = 5;

  const [profile, setProfile] = useState({ name:"", email:"", province:"ON", licenseNumber:"", school:"", graduatingYear:"", isCorp:false });
  const [practice, setPractice] = useState({ name:"", pct:35, basis:"collections", deductsLabFees:false, guarantee:0, color:"#0F6E56" });
  const [bankConnected, setBankConnected] = useState(false);
  const [showPlaid, setShowPlaid] = useState(false);
  const [connectedAccts, setConnectedAccts] = useState([]);

  const selectedProvince = PROVINCES_FULL.find(p=>p.code===profile.province);
  const canStep2 = profile.name.trim()&&profile.email.trim()&&profile.licenseNumber.trim()&&profile.province;
  const canStep3 = practice.name.trim();

  const finish = () => onComplete({ profile, practice:{ ...practice, id:"p1", address:"", city:"", postalCode:"" }, connectedAccts });


  // Step 1 — Welcome
  if(step===1) return (
    <OnboardingShell step={step} total={TOTAL}>
      <div style={{ fontSize:28,fontWeight:800,color:"#1e293b",letterSpacing:"-0.02em",marginBottom:12,lineHeight:1.2 }}>
        Built for dental associates.<br/>Finally.
      </div>
      <div style={{ fontSize:15,color:"#64748b",marginBottom:8,lineHeight:1.6 }}>
        Track your production, reconcile your collections, and know exactly what you're owed — without waiting until tax season.
      </div>
      <div style={{ fontSize:13,color:"#94a3b8",marginBottom:36 }}>Takes about 2 minutes to set up.</div>
      {[
        { icon:"📋", text:"Log production daily — manual or scan your day sheet" },
        { icon:"🏦", text:"Bank feed catches underpayments automatically" },
        { icon:"💰", text:"Know your tax burden before April" },
      ].map(f=>(
        <div key={f.text} style={{ display:"flex",alignItems:"flex-start",gap:12,marginBottom:14 }}>
          <span style={{ fontSize:18,flexShrink:0 }}>{f.icon}</span>
          <span style={{ fontSize:13,color:"#475569",lineHeight:1.5 }}>{f.text}</span>
        </div>
      ))}
      <Btn size="lg" onClick={()=>setStep(2)} style={{ width:"100%",justifyContent:"center",marginTop:36 }}>Get started →</Btn>
      <div style={{ textAlign:"center",marginTop:14,fontSize:12,color:"#94a3b8" }}>
        Already have an account? <span style={{ color:"#0F6E56",cursor:"pointer",fontWeight:600 }}>Sign in</span>
      </div>
    </OnboardingShell>
  );

  // Step 2 — About you
  if(step===2) return (
    <OnboardingShell step={step} total={TOTAL}>
      <div style={{ fontSize:22,fontWeight:800,color:"#1e293b",marginBottom:4 }}>About you</div>
      <div style={{ fontSize:13,color:"#94a3b8",marginBottom:24 }}>This personalizes your experience and verifies your registration.</div>
      <div style={{ display:"flex",flexDirection:"column",gap:16 }}>
        <Input label="Full name *" value={profile.name} onChange={e=>setProfile(p=>({...p,name:e.target.value}))} placeholder="Dr. Jane Smith" />
        <Input label="Email address *" type="email" value={profile.email} onChange={e=>setProfile(p=>({...p,email:e.target.value}))} placeholder="jane@email.com" />
        <Sel label="Province / State *" value={profile.province} onChange={e=>setProfile(p=>({...p,province:e.target.value}))}>
          <optgroup label="Canada">
            {PROVINCES_FULL.filter(p=>!p.code.startsWith("US-")&&p.code!=="OTHER").map(p=><option key={p.code} value={p.code}>{p.name}</option>)}
          </optgroup>
          <optgroup label="United States">
            {PROVINCES_FULL.filter(p=>p.code.startsWith("US-")).map(p=><option key={p.code} value={p.code}>{p.name}</option>)}
          </optgroup>
          <optgroup label="Other">
            <option value="OTHER">Other / International</option>
          </optgroup>
        </Sel>
        <div>
          <Input
            label="College / Board license # *"
            value={profile.licenseNumber}
            onChange={e=>setProfile(p=>({...p,licenseNumber:e.target.value}))}
            placeholder={selectedProvince ? `e.g. ${selectedProvince.example}` : "Your license or registration number"}
          />
          <div style={{ fontSize:11,color:"#94a3b8",marginTop:4 }}>
            Find this on your registration certificate or your provincial college / state dental board member portal.
          </div>
        </div>
        <div style={{ borderTop:"1px solid #f1f5f9",paddingTop:16 }}>
          <div style={{ fontSize:12,color:"#94a3b8",fontWeight:500,textTransform:"uppercase",letterSpacing:"0.05em",marginBottom:14 }}>Optional</div>
          <div style={{ display:"flex",flexDirection:"column",gap:14 }}>
            <Sel label="School / University" value={profile.school} onChange={e=>setProfile(p=>({...p,school:e.target.value}))}>
              <option value="">Select school…</option>
              {DENTAL_SCHOOLS.map(s=><option key={s} value={s}>{s}</option>)}
            </Sel>
            <Sel label="Graduating year" value={profile.graduatingYear} onChange={e=>setProfile(p=>({...p,graduatingYear:e.target.value}))}>
              <option value="">Select year…</option>
              {GRADUATING_YEARS.map(y=><option key={y} value={y}>{y}</option>)}
            </Sel>
          </div>
        </div>
        <div style={{ borderTop:"1px solid #f1f5f9",paddingTop:16 }}>
          <label style={{ display:"flex",alignItems:"flex-start",gap:12,cursor:"pointer" }}>
            <input type="checkbox" checked={profile.isCorp} onChange={e=>setProfile(p=>({...p,isCorp:e.target.checked}))} style={{ width:20,height:20,marginTop:2,flexShrink:0 }} />
            <div>
              <div style={{ fontSize:14,fontWeight:600,color:"#1e293b" }}>I operate through a professional corp</div>
              <div style={{ fontSize:12,color:"#94a3b8",marginTop:2 }}>Enables corporate expense tracking and salary/dividend split. You can change this later.</div>
            </div>
          </label>
        </div>
        <Btn size="lg" onClick={()=>setStep(3)} disabled={!canStep2}
          style={{ width:"100%",justifyContent:"center",marginTop:8,opacity:canStep2?1:0.4 }}>
          Continue →
        </Btn>
      </div>
    </OnboardingShell>
  );

  // Step 3 — First practice
  if(step===3) return (
    <OnboardingShell step={step} total={TOTAL}>
      <div style={{ fontSize:22,fontWeight:800,color:"#1e293b",marginBottom:4 }}>Your practice</div>
      <div style={{ fontSize:13,color:"#94a3b8",marginBottom:24 }}>Add the office you work at. You can add more practices later in Settings.</div>
      <div style={{ display:"flex",flexDirection:"column",gap:16 }}>
        <Input label="Practice name *" value={practice.name} onChange={e=>setPractice(p=>({...p,name:e.target.value}))} placeholder="e.g. Sunshine Dental" />
        <div>
          <div style={{ display:"flex",justifyContent:"space-between",alignItems:"baseline",marginBottom:6 }}>
            <label style={{ fontSize:12,fontWeight:500,color:"#475569" }}>Your pay percentage *</label>
            <span style={{ fontSize:20,fontWeight:800,color:"#1e293b" }}>{practice.pct}%</span>
          </div>
          <input type="range" min={20} max={50} value={practice.pct} onChange={e=>setPractice(p=>({...p,pct:+e.target.value}))} style={{ width:"100%" }} />
          <div style={{ display:"flex",justifyContent:"space-between",fontSize:11,color:"#94a3b8",marginTop:2 }}>
            <span>20%</span><span>50%</span>
          </div>
        </div>
        <Sel label="Pay basis *" value={practice.basis} onChange={e=>setPractice(p=>({...p,basis:e.target.value}))}>
          <option value="collections">Collections — what the practice actually received</option>
          <option value="production">Gross production — your full fee schedule</option>
          <option value="adjusted">Adjusted production — after write-offs</option>
        </Sel>
        <label style={{ display:"flex",alignItems:"flex-start",gap:12,cursor:"pointer",background:"#f8fafc",padding:"12px 14px",borderRadius:10,border:"1px solid #e2e8f0" }}>
          <input type="checkbox" checked={practice.deductsLabFees} onChange={e=>setPractice(p=>({...p,deductsLabFees:e.target.checked}))} style={{ width:20,height:20,marginTop:2,flexShrink:0 }} />
          <div>
            <div style={{ fontSize:14,fontWeight:600,color:"#1e293b" }}>Lab fees deducted before my pay %</div>
            <div style={{ fontSize:12,color:"#94a3b8",marginTop:2 }}>e.g. contract says: 40% of (collections − lab fees). Check your agreement.</div>
          </div>
        </label>
        <Btn size="lg" onClick={()=>setStep(4)} disabled={!canStep3}
          style={{ width:"100%",justifyContent:"center",marginTop:8,opacity:canStep3?1:0.4 }}>
          Continue →
        </Btn>
        <button onClick={()=>setStep(2)} style={{ background:"none",border:"none",color:"#94a3b8",fontSize:13,cursor:"pointer",textAlign:"center" }}>← Back</button>
      </div>
    </OnboardingShell>
  );

  // Step 4 — Connect bank
  if(step===4) return (
    <OnboardingShell step={step} total={TOTAL}>
      {showPlaid&&(
        <PlaidModal
          onConnect={accs=>{ setConnectedAccts(accs); setBankConnected(true); setShowPlaid(false); setStep(5); }}
          onClose={()=>setShowPlaid(false)}
        />
      )}
      <div style={{ fontSize:22,fontWeight:800,color:"#1e293b",marginBottom:4 }}>Connect your bank</div>
      <div style={{ fontSize:13,color:"#94a3b8",marginBottom:24 }}>This is how DentaTrack catches underpayments — by matching deposits against what you were owed.</div>
      <div style={{ background:"#f0fdf4",border:"1px solid #bbf7d0",borderRadius:12,padding:"16px 18px",marginBottom:16 }}>
        <div style={{ fontSize:13,fontWeight:600,color:"#166534",marginBottom:8 }}>What connecting does</div>
        {["Practice deposits show up automatically as collections","Business expenses match to your receipts","Reconciliation runs in the background — you see gaps immediately"].map(t=>(
          <div key={t} style={{ display:"flex",gap:8,fontSize:12,color:"#166534",marginBottom:4 }}><span>✓</span><span>{t}</span></div>
        ))}
      </div>
      <div style={{ background:"#f8fafc",border:"1px solid #e2e8f0",borderRadius:12,padding:"14px 16px",marginBottom:20,fontSize:12,color:"#64748b" }}>
        🔒 Read-only access only — DentaTrack can never move money. Secured by Plaid with 256-bit encryption.
      </div>
      <div style={{ display:"flex",flexDirection:"column",gap:12 }}>
        <Btn size="lg" onClick={()=>setShowPlaid(true)} style={{ width:"100%",justifyContent:"center" }}>🏦 Connect my bank</Btn>
        <button onClick={()=>setStep(5)} style={{ background:"none",border:"none",color:"#94a3b8",fontSize:13,cursor:"pointer",textAlign:"center",padding:"10px 0" }}>
          Skip for now — I'll connect later
        </button>
        <button onClick={()=>setStep(3)} style={{ background:"none",border:"none",color:"#94a3b8",fontSize:13,cursor:"pointer",textAlign:"center" }}>← Back</button>
      </div>
    </OnboardingShell>
  );

  // Step 5 — Ready
  if(step===5) return (
    <OnboardingShell step={step} total={TOTAL}>
      <div style={{ textAlign:"center" }}>
        <div style={{ fontSize:48,marginBottom:16 }}>🎉</div>
        <div style={{ fontSize:24,fontWeight:800,color:"#1e293b",marginBottom:8 }}>
          You're all set{profile.name?`, ${profile.name.replace("Dr.","").trim().split(" ")[0]}`:""}!
        </div>
        <div style={{ fontSize:14,color:"#64748b",marginBottom:8,lineHeight:1.6 }}>
          <strong>{practice.name}</strong> is ready — {practice.pct}% of {practice.basis}{practice.deductsLabFees?" · lab fees deducted":""}
        </div>
        {bankConnected
          ? <div style={{ fontSize:13,color:"#0F6E56",fontWeight:600,marginBottom:24 }}>✓ Bank connected — your feed will populate shortly</div>
          : <div style={{ fontSize:12,color:"#94a3b8",marginBottom:24 }}>Bank not connected yet — add it anytime from Settings.</div>
        }
        <Btn size="lg" onClick={finish} style={{ width:"100%",justifyContent:"center" }}>Log my first day →</Btn>
      </div>
    </OnboardingShell>
  );

  return null;
};

// ── App ───────────────────────────────────────────────────────────────────────
const TABS = [
  { key:"home",         label:"Home",         icon:"🏠", active:true  },
  { key:"production",   label:"Production",   icon:"📋", active:true  },
  { key:"transactions", label:"Transactions",  icon:"💳", active:true  },
  // Future tabs — uncomment to activate as features mature
  // { key:"tax",       label:"Tax",           icon:"📊", active:false },
  // { key:"insights",  label:"Insights",      icon:"💡", active:false },
];

const FUTURE_TABS = [
  { key:"tax",      label:"Tax planning", icon:"📊", desc:"RRSP optimizer, tax burden projection" },
  { key:"insights", label:"Insights",     icon:"💡", desc:"Benchmarking, multi-practice trends"   },
];

export default function App() {
  const [tab, setTab]               = useState("home");
  const [userId, setUserId]         = useState(null);
  const [dataLoaded, setDataLoaded] = useState(false);

  const [production, setProduction] = useState([]);
  const [expenses, setExpenses]     = useState([]);
  const [banks, setBanks]           = useState([]);
  const [bankRules, setBankRules]   = useState([]);
  const [practices, setPractices]   = useState([]);
  const [agreement, setAgreement]   = useState({ isCorp:false,salary:0,dividends:0,name:"",corpName:"" });
  const [connectedAccounts, setConnectedAccounts] = useState([]);
  const [menuOpen, setMenuOpen]     = useState(false);
  const [settingsSection, setSettingsSection] = useState(null);

  // Load everything for the logged-in dentist once, on mount
  useEffect(() => {
    let cancelled = false;
    supabase.auth.getUser().then(async ({ data }) => {
      const uid = data?.user?.id;
      if (!uid || cancelled) return;
      setUserId(uid);
      const [profile, prac, prod, exp, bnk, rules, accts] = await Promise.all([
        loadProfile(uid), loadPractices(uid), loadProduction(uid), loadExpenses(uid),
        loadBanks(uid), loadBankRules(uid), loadConnectedAccounts(uid),
      ]);
      if (cancelled) return;
      if (profile) setAgreement(profile);
      setPractices(prac);
      setProduction(prod);
      setExpenses(exp);
      setBanks(bnk);
      setBankRules(rules);
      setConnectedAccounts(accts);
      setDataLoaded(true);
    });
    return () => { cancelled = true; };
  }, []);

  // From here down: every time one of these arrays changes (after the
  // initial load), push the change to Supabase so it survives refreshes
  // and shows up on any device the dentist signs into.
  useEffect(() => { if (dataLoaded && userId) syncPractices(userId, practices); }, [practices, dataLoaded, userId]);
  useEffect(() => { if (dataLoaded && userId) syncProduction(userId, production); }, [production, dataLoaded, userId]);
  useEffect(() => { if (dataLoaded && userId) syncExpenses(userId, expenses); }, [expenses, dataLoaded, userId]);
  useEffect(() => { if (dataLoaded && userId) syncBanks(userId, banks); }, [banks, dataLoaded, userId]);
  useEffect(() => { if (dataLoaded && userId) syncBankRules(userId, bankRules); }, [bankRules, dataLoaded, userId]);
  useEffect(() => { if (dataLoaded && userId) syncConnectedAccounts(userId, connectedAccounts); }, [connectedAccounts, dataLoaded, userId]);
  useEffect(() => { if (dataLoaded && userId) saveProfile(userId, agreement); }, [agreement, dataLoaded, userId]);

  // Tag a transaction and optionally create a rule
  const tagBank = (id, updates, createRule=false) => {
    setBanks(bk => bk.map(x => x.id===id ? { ...x,...updates,userTagged:true,reviewed:true,autoTagged:false } : x));
    if (createRule) {
      const tx = banks.find(b=>b.id===id);
      if (tx) {
        const rule = { ...ruleFromTag(tx.description, updates), id: newId() };
        setBankRules(r => [rule, ...r]);
      }
    }
  };

  const addRule    = (rule)  => setBankRules(r => [{ ...rule, id: rule.id && isNaN(rule.id) ? rule.id : newId() }, ...r]);
  const updateRule = (id,up) => setBankRules(r => r.map(x=>x.id===id?{...x,...up}:x));
  const deleteRule = (id)    => setBankRules(r => r.filter(x=>x.id!==id));

  if (!dataLoaded) {
    return (
      <div style={{ minHeight:"100vh",display:"flex",alignItems:"center",justifyContent:"center",fontFamily:"system-ui,-apple-system,sans-serif",color:"#94a3b8" }}>
        Loading your data…
      </div>
    );
  }

  const isMobile   = useIsMobile();
  const smartBanks = applyRules(banks, bankRules);
  const matches    = buildMatches(expenses, smartBanks);

  // Collections summary per practice
  const collectionsSummary = practices.map(pr => {
    const prDeposits = smartBanks.filter(b=>b.type==="collection"&&b.practiceId===pr.id).reduce((s,b)=>s+b.amount,0);
    const prProd     = production.filter(r=>r.practiceId===pr.id).reduce((s,r)=>s+r.production,0);
    const rate       = prProd>0 ? (prDeposits/prProd)*100 : null;
    return { pr, deposits:prDeposits, production:prProd, rate };
  });

  const goToSettings = (section) => {
    setTab("settings");
    setSettingsSection(section);
    setMenuOpen(false);
  };

  const initials = agreement.name
    ? agreement.name.replace("Dr.","").trim().split(" ").map(w=>w[0]).slice(0,2).join("").toUpperCase()
    : "DA";

  return(
    <div className="dt-app" style={{ minHeight:"100vh",background:"#f8fafc",fontFamily:"system-ui,-apple-system,sans-serif",paddingBottom:isMobile?70:0 }} onClick={()=>menuOpen&&setMenuOpen(false)}>
      <GlobalStyles />

      {/* Header */}
      <div style={{ background:"#fff",borderBottom:"1px solid #e2e8f0",padding:isMobile?"0 16px":"0 32px",position:"sticky",top:0,zIndex:100 }}>
        <div style={{ maxWidth:1100,margin:"0 auto",display:"flex",alignItems:"center",gap:24 }}>
          {/* Logo */}
          <div style={{ padding:"14px 0",display:"flex",alignItems:"center",gap:10,flex:1 }}>
            <div style={{ width:30,height:30,background:"#0F6E56",borderRadius:8,display:"flex",alignItems:"center",justifyContent:"center",color:"#fff",fontWeight:800,fontSize:14,flexShrink:0 }}>D</div>
            <div style={{ minWidth:0 }}>
              <div style={{ fontWeight:800,fontSize:15,color:"#1e293b",letterSpacing:"-0.01em" }}>DentaTrack</div>
              {!isMobile&&<div style={{ fontSize:10,color:"#94a3b8",letterSpacing:"0.04em",textTransform:"uppercase" }}>{agreement.isCorp?"Corp":"Personal"} · {practices.length} practice{practices.length!==1?"s":""}</div>}
            </div>
          </div>

          {/* Desktop nav */}
          {!isMobile&&(
            <nav style={{ display:"flex",gap:2 }}>
              {TABS.filter(t=>t.active).map(t=>(
                <button key={t.key} onClick={()=>setTab(t.key)} style={{ padding:"6px 14px",border:"none",borderRadius:7,fontSize:13,fontWeight:600,cursor:"pointer",background:tab===t.key?"#E1F5EE":"transparent",color:tab===t.key?"#0F6E56":"#64748b" }}>
                  {t.label}
                </button>
              ))}
            </nav>
          )}

          {/* Avatar — tappable, opens profile menu */}
          <div style={{ position:"relative",flexShrink:0 }} onClick={e=>{ e.stopPropagation(); setMenuOpen(m=>!m); }}>
            <div style={{ background:"#0F6E56",color:"#fff",width:34,height:34,borderRadius:99,display:"flex",alignItems:"center",justifyContent:"center",fontWeight:700,fontSize:13,cursor:"pointer",userSelect:"none",boxShadow:menuOpen?"0 0 0 3px #E1F5EE":"none" }}>
              {initials}
            </div>

            {/* Dropdown menu */}
            {menuOpen&&(
              <div onClick={e=>e.stopPropagation()} style={{ position:"absolute",top:42,right:0,width:280,background:"#fff",border:"1px solid #e2e8f0",borderRadius:12,boxShadow:"0 8px 32px rgba(0,0,0,0.12)",zIndex:200,overflow:"hidden" }}>
                {/* Profile header */}
                <div style={{ padding:"14px 16px",borderBottom:"1px solid #f1f5f9",background:"#f8fafc" }}>
                  <div style={{ fontWeight:700,color:"#1e293b",fontSize:14 }}>{agreement.name||"Your profile"}</div>
                  {agreement.corpName&&<div style={{ fontSize:12,color:"#64748b",marginTop:2 }}>{agreement.corpName}</div>}
                  <div style={{ fontSize:11,color:"#94a3b8",marginTop:2 }}>{agreement.isCorp?"Professional corp":"Personal"} · {practices.length} practice{practices.length!==1?"s":""}</div>
                </div>

                {/* Menu items */}
                {[
                  { label:"Profile & corp settings", icon:"👤", section:"profile"   },
                  { label:"Practices",               icon:"🏥", section:"practices" },
                  { label:"Connected accounts",      icon:"🏦", section:"accounts"  },
                  { label:"Bank rules",              icon:"🧠", section:"rules"     },
                ].map(item=>(
                  <button key={item.label} onClick={()=>goToSettings(item.section)} style={{ width:"100%",padding:"11px 16px",border:"none",background:"transparent",display:"flex",alignItems:"center",gap:10,cursor:"pointer",textAlign:"left",fontSize:13,color:"#1e293b",fontWeight:500 }}
                    onMouseEnter={e=>e.currentTarget.style.background="#f8fafc"}
                    onMouseLeave={e=>e.currentTarget.style.background="transparent"}>
                    <span style={{ fontSize:16 }}>{item.icon}</span>{item.label}
                  </button>
                ))}

                {/* Coming soon tabs */}
                <div style={{ borderTop:"1px solid #f1f5f9",padding:"8px 16px 4px" }}>
                  <div style={{ fontSize:10,color:"#94a3b8",fontWeight:600,textTransform:"uppercase",letterSpacing:"0.06em",marginBottom:6 }}>Coming soon</div>
                  {FUTURE_TABS.map(ft=>(
                    <div key={ft.key} style={{ display:"flex",alignItems:"center",gap:10,padding:"8px 0",opacity:0.5 }}>
                      <span style={{ fontSize:16 }}>{ft.icon}</span>
                      <div>
                        <div style={{ fontSize:13,fontWeight:500,color:"#475569" }}>{ft.label}</div>
                        <div style={{ fontSize:11,color:"#94a3b8" }}>{ft.desc}</div>
                      </div>
                    </div>
                  ))}
                </div>

                <div style={{ borderTop:"1px solid #f1f5f9",padding:"8px 16px 12px" }}>
                  <button style={{ width:"100%",padding:"9px 0",border:"none",background:"transparent",color:"#000000",fontSize:13,cursor:"pointer",textAlign:"left" }}>Sign out</button>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Content */}
      <div style={{ maxWidth:1100,margin:"0 auto",padding:isMobile?"20px 16px":"28px 32px" }}>
        <div style={{ marginBottom:isMobile?18:24 }}>
          <div style={{ fontSize:isMobile?19:22,fontWeight:800,color:"#1e293b",letterSpacing:"-0.02em" }}>
            {tab==="home"?"Home":tab==="production"?"Production":tab==="transactions"?"Transactions":"Settings"}
          </div>
          <div style={{ fontSize:13,color:"#94a3b8",marginTop:2 }}>
            {tab==="home"&&"Your financial snapshot for the month"}
            {tab==="production"&&"Log production and review your daily entries"}
            {tab==="transactions"&&"Expenses, bank feed, and reconciliation"}
            {tab==="settings"&&"Profile, practices, and corp settings"}
          </div>
        </div>
        {tab==="home"         &&<HomeTab         production={production} expenses={expenses} banks={smartBanks} agreement={agreement} matches={matches} practices={practices} isMobile={isMobile} collectionsSummary={collectionsSummary}/>}
        {tab==="production"   &&<ProductionTab   production={production} setProduction={setProduction} practices={practices}/>}
        {tab==="transactions" &&<TransactionsTab expenses={expenses} setExpenses={setExpenses} banks={smartBanks} setBanks={setBanks} tagBank={tagBank} agreement={agreement} matches={matches} practices={practices} production={production} isMobile={isMobile} bankRules={bankRules} addRule={addRule}/>}
        {tab==="settings"     &&<SettingsTab     agreement={agreement} setAgreement={setAgreement} practices={practices} setPractices={setPractices} isMobile={isMobile} connectedAccounts={connectedAccounts} setConnectedAccounts={setConnectedAccounts} activeSection={settingsSection} bankRules={bankRules} addRule={addRule} updateRule={updateRule} deleteRule={deleteRule}/>}
      </div>

      {/* Mobile bottom tab bar — 2 active tabs + future stubs */}
      {isMobile&&(
        <nav style={{ position:"fixed",bottom:0,left:0,right:0,background:"#fff",borderTop:"1px solid #e2e8f0",display:"flex",zIndex:100,paddingBottom:"env(safe-area-inset-bottom)" }}>
          {TABS.filter(t=>t.active).map(t=>(
            <button key={t.key} onClick={()=>setTab(t.key)} style={{ flex:1,border:"none",background:"transparent",cursor:"pointer",padding:"8px 0 10px",display:"flex",flexDirection:"column",alignItems:"center",gap:2,color:tab===t.key?"#0F6E56":"#94a3b8" }}>
              <span style={{ fontSize:18 }}>{t.icon}</span>
              <span style={{ fontSize:11,fontWeight:600 }}>{t.label}</span>
            </button>
          ))}
          {/* Future tab stubs — greyed out, non-tappable */}
          {FUTURE_TABS.map(ft=>(
            <button key={ft.key} disabled style={{ flex:1,border:"none",background:"transparent",cursor:"default",padding:"8px 0 10px",display:"flex",flexDirection:"column",alignItems:"center",gap:2,color:"#d1d5db",opacity:0.5 }}>
              <span style={{ fontSize:18 }}>{ft.icon}</span>
              <span style={{ fontSize:10,fontWeight:600 }}>{ft.label}</span>
            </button>
          ))}
        </nav>
      )}
    </div>
  );
}
