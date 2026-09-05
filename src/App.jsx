import { useState, useRef, useEffect } from "react";
import { usePlaidLink } from "react-plaid-link";
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

// True only when running as the actual installed app (added to home screen /
// installed as a PWA) — false for a normal browser tab, even on mobile.
// Safari's own pull-to-refresh should keep working untouched for anyone
// just visiting the site; our custom refresh gesture is only for people
// using the installed app, which has no browser chrome to pull from.
const useIsStandalone = () => {
  const [isStandalone, setIsStandalone] = useState(false);
  useEffect(() => {
    const check = () =>
      window.matchMedia?.('(display-mode: standalone)').matches ||
      window.navigator.standalone === true; // iOS Safari's own flag
    setIsStandalone(check());
  }, []);
  return isStandalone;
};

const GlobalStyles = () => (
  <style>{`
    .dt-app { -webkit-tap-highlight-color: transparent; }
    @keyframes dt-spin { to { transform: rotate(360deg); } }
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
      /* iOS Safari auto-zooms in on any input/select/textarea smaller than
         16px the moment it's focused, then leaves you zoomed in until you
         manually pinch back out. Forcing every field to 16px here removes
         the trigger entirely, instead of disabling zoom app-wide (which
         would also block people who actually want to zoom for readability). */
      input, select, textarea { font-size: 16px !important; }
    }
  `}</style>
);

const fmt = (n) => new Intl.NumberFormat("en-CA", { style:"currency", currency:"CAD" }).format(n);
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

// ── Merchant name cleaning (display only — raw description stays intact for matching) ──
function cleanMerchantName(raw) {
  if (!raw) return raw;
  let s = raw;
  s = s.replace(/\b\d{3}[-.\s]\d{3}[-.\s]\d{4}\b/g, "");       // phone numbers
  s = s.replace(/#?\b\d{4,}\b/g, "");                          // long ref/store numbers
  s = s.replace(/\s+[A-Z]{2}$/, "");                            // trailing province/state code
  s = s.replace(/\s{2,}/g, " ").trim();
  if (!s) return raw.trim();
  s = s.split(" ").map(w => {
    if (/^[A-Z]{2,3}$/.test(w)) return w;                       // keep short acronyms as-is
    if (/^[A-Z0-9&']+$/.test(w) && w.length > 3) return w.charAt(0) + w.slice(1).toLowerCase();
    return w;
  }).join(" ");
  return s;
}

// ── Transfer detection ──────────────────────────────────────────────────────
// Heuristic only: we don't yet track which connected account each transaction
// came from, so this pairs opposite-sign transactions of matching amount within
// a few days of each other. Works well for the common case (moving money
// between your own accounts, paying a card bill) but can occasionally misfire
// on coincidental same-amount transactions — tracking a per-transaction
// account id would make this exact instead of a heuristic.
function flagTransfers(banks) {
  const used = new Set();
  const results = banks.map(b => ({ ...b }));
  const byId = new Map(results.map(b => [b.id, b]));
  for (const a of results) {
    if (a.userTagged || a.autoTagged || used.has(a.id)) continue;
    for (const b of results) {
      if (a.id === b.id || used.has(b.id) || b.userTagged || b.autoTagged) continue;
      const oppositeSign = (a.amount > 0) !== (b.amount > 0);
      const amtMatch = Math.abs(Math.abs(a.amount) - Math.abs(b.amount)) < 1;
      const dayDiff = Math.abs(new Date(a.date).getTime() - new Date(b.date).getTime()) / 86400000;
      if (oppositeSign && amtMatch && dayDiff <= 3) {
        byId.get(a.id).type = "transfer"; byId.get(a.id).autoTagged = true;
        byId.get(b.id).type = "transfer"; byId.get(b.id).autoTagged = true;
        used.add(a.id); used.add(b.id);
        break;
      }
    }
  }
  return results;
}

// ── Duplicate detection ─────────────────────────────────────────────────────
// Same amount, same sign, within a day of each other — flagged for the user
// to review rather than silently hidden, since a false positive here would
// mean a real transaction quietly disappears from someone's books.
function detectDuplicates(banks) {
  const dupIds = new Set();
  for (let i = 0; i < banks.length; i++) {
    for (let j = i + 1; j < banks.length; j++) {
      const a = banks[i], b = banks[j];
      const amtMatch = Math.abs(Math.abs(a.amount) - Math.abs(b.amount)) < 0.01 && Math.sign(a.amount) === Math.sign(b.amount);
      const dayDiff = Math.abs(new Date(a.date).getTime() - new Date(b.date).getTime()) / 86400000;
      if (amtMatch && dayDiff <= 1) { dupIds.add(a.id); dupIds.add(b.id); }
    }
  }
  return dupIds;
}

// ── Deductible amount — aware of split transactions ─────────────────────────
function deductibleAmount(b) {
  if (b.splits && b.splits.length) {
    return b.splits.reduce((s, sp) => s + (sp.taxDeductible ? Math.abs(sp.amount) * (sp.deductibleFraction ?? 1) : 0), 0);
  }
  return (b.type === "business" && b.taxDeductible) ? Math.abs(b.amount) * (b.deductibleFraction ?? 1) : 0;
}

// ── Global period filter (Home / Production / Transactions) ────────────────
const PERIOD_LABELS = { day: "Day", week: "Week", month: "Month", year: "Year" };
const PERIOD_BUCKET_COUNTS = { day: 7, week: 8, month: 6, year: 5 };

// The current window for a given granularity — e.g. "month" means the
// calendar month containing refDate, not a rolling 30 days.
function periodRange(period, refDate = new Date()) {
  const d = new Date(refDate);
  d.setHours(0, 0, 0, 0);
  if (period === "day") {
    const start = new Date(d);
    const end = new Date(d); end.setDate(end.getDate() + 1);
    return { start, end };
  }
  if (period === "week") {
    const start = new Date(d); start.setDate(d.getDate() - d.getDay());
    const end = new Date(start); end.setDate(start.getDate() + 7);
    return { start, end };
  }
  if (period === "year") {
    return { start: new Date(d.getFullYear(), 0, 1), end: new Date(d.getFullYear() + 1, 0, 1) };
  }
  return { start: new Date(d.getFullYear(), d.getMonth(), 1), end: new Date(d.getFullYear(), d.getMonth() + 1, 1) };
}

function dateInRange(dateStr, range) {
  const t = new Date(dateStr + "T00:00:00").getTime();
  return t >= range.start.getTime() && t < range.end.getTime();
}

// Trailing windows ending at the current period, sized per granularity, for
// the Financial performance chart — the last bucket always lines up with
// whatever the stat cards above are currently showing.
function periodBuckets(period, count, refDate = new Date()) {
  const buckets = [];
  for (let i = count - 1; i >= 0; i--) {
    const d = new Date(refDate);
    if (period === "day") d.setDate(d.getDate() - i);
    else if (period === "week") d.setDate(d.getDate() - i * 7);
    else if (period === "year") d.setFullYear(d.getFullYear() - i);
    else d.setMonth(d.getMonth() - i);
    const range = periodRange(period, d);
    let label;
    if (period === "day") label = range.start.toLocaleDateString(undefined, { weekday: "short" });
    else if (period === "week") label = range.start.toLocaleDateString(undefined, { month: "short", day: "numeric" });
    else if (period === "year") label = String(range.start.getFullYear());
    else label = range.start.toLocaleDateString(undefined, { month: "short" });
    buckets.push({ label, ...range });
  }
  return buckets;
}

// Shared by the Expected pay stat card and each Financial performance chart
// bucket — same math, just fed a different (possibly narrower) time slice.
function computeExpectedPay(practices, production, banks) {
  return practices.reduce((sum, pr) => {
    const prDeps = banks.filter(b => b.type === "collection" && b.practiceId === pr.id).reduce((s, b) => s + b.amount, 0);
    const prLab = pr.deductsLabFees ? production.filter(r => r.practiceId === pr.id).reduce((s, r) => s + (r.labFees || 0), 0) : 0;
    return sum + Math.max(0, prDeps - prLab) * (pr.pct / 100);
  }, 0);
}


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
// A deliberate, tappable toggle for a real choice in a form — used where a
// plain checkbox would read as an easy-to-miss afterthought rather than an
// actual decision the person is making (e.g. flagging a redo).
const ToggleRow = ({ checked, onChange, icon, label, sub }) => (
  <button type="button" onClick={()=>onChange(!checked)} style={{
    display:"flex", alignItems:"center", justifyContent:"space-between", gap:12,
    width:"100%", textAlign:"left", cursor:"pointer", font:"inherit",
    background: checked ? "#fef3c7" : "#f8fafc",
    border: "1px solid " + (checked ? "#fde68a" : "#e2e8f0"),
    borderRadius: 10, padding: "12px 14px",
  }}>
    <div style={{ display:"flex", gap:10, alignItems:"flex-start" }}>
      {icon&&<span style={{ fontSize:18,lineHeight:"20px" }}>{icon}</span>}
      <div>
        <div style={{ fontSize:13,fontWeight:700,color:"#1e293b" }}>{label}</div>
        {sub&&<div style={{ fontSize:12,color:"#64748b",marginTop:2 }}>{sub}</div>}
      </div>
    </div>
    <span style={{ width:38,height:22,borderRadius:99,flexShrink:0,position:"relative",background: checked?"#0F6E56":"#cbd5e1",transition:"background 0.15s" }}>
      <span style={{ position:"absolute",top:2,left: checked?18:2,width:18,height:18,borderRadius:"50%",background:"#fff",transition:"left 0.15s",boxShadow:"0 1px 2px rgba(0,0,0,0.2)" }} />
    </span>
  </button>
);
const PracticeDot = ({ color, name }) => (
  <span style={{ display:"inline-flex", alignItems:"center", gap:5 }}>
    <span style={{ width:8, height:8, borderRadius:"50%", background:color, flexShrink:0 }} />
    <span style={{ fontSize:12, color:"#475569", fontWeight:500 }}>{name}</span>
  </span>
);
const Card = ({ children, style, className, ...rest }) => (
  <div className={className} style={{ background:"#fff", borderRadius:12, border:"1px solid #e2e8f0", padding:"20px 24px", ...style }} {...rest}>{children}</div>
);
const StatCard = ({ label, value, sub, color="#0F6E56", onClick }) => (
  <Card onClick={onClick} style={{ flex:1, minWidth:150, cursor:onClick?"pointer":"default", transition:"box-shadow 0.15s, transform 0.15s" }}
    onMouseEnter={onClick?(e=>{ e.currentTarget.style.boxShadow="0 4px 14px rgba(0,0,0,0.08)"; e.currentTarget.style.transform="translateY(-1px)"; }):undefined}
    onMouseLeave={onClick?(e=>{ e.currentTarget.style.boxShadow=""; e.currentTarget.style.transform=""; }):undefined}>
    <div style={{ fontSize:11, color:"#64748b", fontWeight:500, marginBottom:6, textTransform:"uppercase", letterSpacing:"0.06em" }}>{label}</div>
    <div style={{ fontSize:24, fontWeight:700, color, letterSpacing:"-0.02em" }}>{value}</div>
    {sub && <div style={{ fontSize:12, color:"#94a3b8", marginTop:4 }}>{sub}</div>}
    {onClick && <div style={{ fontSize:11, color:"#0F6E56", fontWeight:600, marginTop:6 }}>View →</div>}
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
  const [diagnostic, setDiagnostic] = useState(null);
  const ref = useRef();
  const loadFile = (f) => {
    setFile(f); setResult(null); setLog([]); setError(null); setDiagnostic(null);
    const r = new FileReader(); r.onload = e => setPreview(e.target.result); r.readAsDataURL(f);
  };
  const scan = async () => {
    if (!file||!preview) return;
    setScanning(true); setLog([]); setError(null); setDiagnostic(null); setResult(null);
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
      if (data.diagnostic) setDiagnostic(data.diagnostic);
    } catch (e) { clearInterval(iv); setError(e.message || "Could not read this image. Try a clearer photo."); }
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
          <div style={{ fontSize:13,fontWeight:600,color:"#475569",marginBottom:4 }}>Review before importing</div>
          <div style={{ fontSize:11,color:"#94a3b8",marginBottom:10 }}>Scans aren't perfect — fix anything wrong or fill in anything it missed.</div>
          {diagnostic&&(
            <div style={{ background:"#fef2f2",border:"1px solid #fecaca",borderRadius:8,padding:"10px 12px",fontSize:12,color:"#991b1b",marginBottom:12 }}>
              ⚠ {diagnostic}
            </div>
          )}
          <div style={{ display:"flex",flexDirection:"column",gap:8,marginBottom:14 }}>
            {Object.entries(result).map(([k,v])=>(
              <div key={k}>
                <div style={{ fontSize:11,color:"#64748b",textTransform:"capitalize",marginBottom:3 }}>{k.replace(/_/g," ")}</div>
                <input
                  value={Array.isArray(v)?v.join(", "):String(v??"")}
                  onChange={e=>setResult(r=>({...r,[k]:e.target.value}))}
                  style={{ width:"100%",boxSizing:"border-box",padding:"7px 10px",border:"1px solid #e2e8f0",borderRadius:7,fontSize:13,color:"#1e293b" }}
                />
              </div>
            ))}
          </div>
          <div style={{ display:"flex",gap:8 }}>
            <Btn variant="secondary" onClick={()=>{setFile(null);setPreview(null);setResult(null);}}>Rescan</Btn>
            <Btn onClick={()=>{ onResult(result, { imageBase64: preview.split(",")[1], mimeType: file.type||"image/jpeg" }); onClose(); }}>Import</Btn>
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
  const [label, setLabel] = useState("");       // defaults to date, editable
  const [labelTouched, setLabelTouched] = useState(false); // has the user typed their own name?
  const [receiptImg, setReceiptImg] = useState(null);
  // A redo/remake — redoing a prior procedure, usually at no charge to the
  // patient (warranty work, a lab remake, correcting a failed restoration).
  // Tracked separately since it's still worth logging for your own records,
  // but it isn't new revenue-generating work the way the rest of your
  // production is.
  const [isRedo, setIsRedo] = useState(false);
  const [redoNotes, setRedoNotes] = useState("");

  const practice = practices.find(p=>p.id===practiceId);
  const tracksLab = !!practice?.deductsLabFees;

  const save = () => {
    if(!amount||!practiceId) return;
    onSave({ date, practiceId, production:+amount, labFees:+(labFees||0), source: receiptImg?"daysheet":"manual", label: label||date, receipt: receiptImg, isRedo, redoNotes: isRedo ? redoNotes : "" });
    onClose();
  };

  return (
    <div className="dt-modal-overlay" style={{ position:"fixed",inset:0,background:"rgba(0,0,0,0.45)",display:"flex",alignItems:"center",justifyContent:"center",zIndex:1000 }}>
      {showScan&&<ScanModal title="Scan Day Sheet"
        prompt="Read a dental day sheet / production report. Extract: date (YYYY-MM-DD), total_production (number), total_collection (number if visible), total_lab_fees (number if visible)."
        onClose={()=>setShowScan(false)}
        onResult={(r, img)=>{
          if(r.date){ setDate(r.date); if(!labelTouched) setLabel(r.date); }
          if(r.total_production!=null) setAmount(String(r.total_production));
          if(r.total_lab_fees!=null) setLabFees(String(r.total_lab_fees));
          setReceiptImg(img || null);
          setMode("manual");
        }} />}
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
          <Input label="Date" type="date" value={date} onChange={e=>{ setDate(e.target.value); if(!labelTouched) setLabel(e.target.value); }} />
          <Input label="Entry name" value={label||date} onChange={e=>{ setLabel(e.target.value); setLabelTouched(true); }} placeholder="Defaults to the date — edit if you'd like to name it" />
          {receiptImg&&<div style={{ fontSize:12,color:"#166534" }}>📎 Day sheet photo attached — you'll be able to view it later</div>}

          {mode==="manual" ? (
            <>
              <button onClick={()=>setShowScan(true)} style={{ display:"flex",alignItems:"center",gap:6,background:"none",border:"1px dashed #cbd5e1",borderRadius:8,padding:"8px 10px",fontSize:12,fontWeight:600,color:"#0F6E56",cursor:"pointer",width:"fit-content" }}>📷 Scan day sheet to autofill</button>
              <Input label="Total production today ($)" type="number" value={amount} onChange={e=>setAmount(e.target.value)} placeholder="0" autoFocus />
              {tracksLab&&(
                <Input label="Lab fees today ($, if any)" type="number" value={labFees} onChange={e=>setLabFees(e.target.value)} placeholder="0" />
              )}
              <ToggleRow checked={isRedo} onChange={setIsRedo} icon="🔁" label="This includes a redo"
                sub="Redoing or remaking a prior procedure, usually at no charge to the patient" />
              {isRedo&&(
                <Input label="What's being redone (optional)" value={redoNotes} onChange={e=>setRedoNotes(e.target.value)} placeholder="e.g. crown remake, tooth #14" />
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

// ── Feedback ─────────────────────────────────────────────────────────────
// Every bug or confusing moment for a beta tester used to only ever reach
// Hadi if they went out of their way to track him down separately. This is
// that missing "tell someone, right now, from wherever you are" button.
const FEEDBACK_TYPES = [
  { v:"bug",   l:"🐞 Something's broken" },
  { v:"idea",  l:"💡 Feature idea" },
  { v:"other", l:"💬 Something else" },
];
const FeedbackModal = ({ onClose, currentTab }) => {
  const [type, setType] = useState("bug");
  const [message, setMessage] = useState("");
  const [status, setStatus] = useState("idle"); // idle | sending | sent | error
  const [error, setError] = useState("");

  const send = async () => {
    if (!message.trim()) return;
    setStatus("sending");
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const resp = await fetch("/api/send-feedback", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${session?.access_token}` },
        body: JSON.stringify({ type, message, page: currentTab }),
      });
      const json = await resp.json();
      if (!resp.ok) throw new Error(json.error || "Could not send feedback.");
      setStatus("sent");
    } catch (e) {
      setError(e.message);
      setStatus("error");
    }
  };

  return (
    <div className="dt-modal-overlay" style={{ position:"fixed",inset:0,background:"rgba(0,0,0,0.45)",display:"flex",alignItems:"center",justifyContent:"center",zIndex:1200 }}>
      <Card className="dt-modal-card" style={{ width:420,padding:28,overflowY:"auto",maxHeight:"90vh" }}>
        {status==="sent" ? (
          <div style={{ textAlign:"center",padding:"20px 0" }}>
            <div style={{ fontSize:32,marginBottom:10 }}>✅</div>
            <div style={{ fontWeight:700,color:"#1e293b",marginBottom:4 }}>Thanks — sent!</div>
            <div style={{ fontSize:13,color:"#64748b",marginBottom:20 }}>This goes straight to the team building the app.</div>
            <Btn onClick={onClose}>Close</Btn>
          </div>
        ) : (
          <>
            <div style={{ display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:16 }}>
              <div style={{ fontSize:16,fontWeight:700,color:"#1e293b" }}>Send feedback</div>
              <Btn variant="ghost" size="sm" onClick={onClose}>Close</Btn>
            </div>
            <div style={{ fontSize:13,color:"#64748b",marginBottom:18 }}>Found a bug, or something feel off? Tell us — this goes straight to the team, not into a void.</div>
            <div style={{ display:"flex",gap:6,marginBottom:16 }}>
              {FEEDBACK_TYPES.map(t=>(
                <button key={t.v} onClick={()=>setType(t.v)} style={{ flex:1,padding:"8px 4px",border:"1px solid "+(type===t.v?"#0F6E56":"#e2e8f0"),borderRadius:8,fontSize:12,fontWeight:600,cursor:"pointer",background:type===t.v?"#E1F5EE":"#fff",color:type===t.v?"#0F6E56":"#64748b" }}>
                  {t.l}
                </button>
              ))}
            </div>
            <textarea value={message} onChange={e=>setMessage(e.target.value)} rows={5} placeholder="What happened? The more detail, the easier it is to fix."
              style={{ width:"100%",boxSizing:"border-box",padding:"10px 12px",border:"1px solid #e2e8f0",borderRadius:8,fontSize:13,fontFamily:"inherit",resize:"vertical",marginBottom:12 }}/>
            {status==="error" && <div style={{ background:"#fee2e2",color:"#991b1b",borderRadius:8,padding:"10px 14px",fontSize:13,marginBottom:12 }}>{error}</div>}
            <Btn size="lg" onClick={send} disabled={!message.trim()||status==="sending"} style={{ width:"100%",justifyContent:"center",opacity:(!message.trim()||status==="sending")?0.6:1 }}>
              {status==="sending" ? "Sending…" : "Send feedback"}
            </Btn>
          </>
        )}
      </Card>
    </div>
  );
};

const EmailReportModal = ({ agreement, period, expectedPay, totalExp, net, practiceBreakdown, expenseByCategory, onClose }) => {
  const [email, setEmail] = useState("");
  const [status, setStatus] = useState("idle"); // idle | sending | sent | error
  const [error, setError] = useState("");

  const send = async () => {
    setStatus("sending");
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const resp = await fetch("/api/email-report", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${session?.access_token}` },
        body: JSON.stringify({
          to: email,
          corpName: agreement.corpName || agreement.name,
          period, expectedPay, totalExp, net, practiceBreakdown, expenseByCategory,
        }),
      });
      const json = await resp.json();
      if (!resp.ok) throw new Error(json.error || "Could not send the report.");
      setStatus("sent");
    } catch (e) {
      setError(e.message);
      setStatus("error");
    }
  };

  return (
    <div className="dt-modal-overlay" style={{ position:"fixed",inset:0,background:"rgba(0,0,0,0.45)",display:"flex",alignItems:"center",justifyContent:"center",zIndex:1000 }}>
      <Card className="dt-modal-card" style={{ width:420,padding:28,overflowY:"auto",maxHeight:"90vh" }}>
        <div style={{ display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:20 }}>
          <div style={{ fontSize:17,fontWeight:700,color:"#1e293b" }}>Email my P&L</div>
          <Btn variant="ghost" size="sm" onClick={onClose}>Close</Btn>
        </div>
        {status!=="sent" ? (
          <>
            <div style={{ fontSize:13,color:"#64748b",marginBottom:16 }}>We'll generate a P&L summary for {period} and send it as a PDF — handy for your accountant.</div>
            <Input label="Send to" type="email" value={email} onChange={e=>setEmail(e.target.value)} placeholder="you@email.com or accountant@firm.com" />
            {status==="error" && <div style={{ background:"#fee2e2",color:"#991b1b",borderRadius:8,padding:"10px 14px",fontSize:13,marginTop:12 }}>{error}</div>}
            <Btn size="lg" onClick={send} style={{ justifyContent:"center", marginTop:16, width:"100%" }} disabled={!email||status==="sending"}>
              {status==="sending" ? "Sending…" : "Send report"}
            </Btn>
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
  const [viewingReceipt, setViewingReceipt] = useState(false);
  const pr = practices.find(p=>p.id===form.practiceId);
  return (
    <div className="dt-modal-overlay" style={{ position:"fixed",inset:0,background:"rgba(0,0,0,0.45)",display:"flex",alignItems:"center",justifyContent:"center",zIndex:1000 }}>
      {viewingReceipt&&<ReceiptViewer receipt={form.receipt} onClose={()=>setViewingReceipt(false)}/>}
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
          <Input label="Entry name" value={form.label||form.date} onChange={e=>setForm(f=>({...f,label:e.target.value}))} placeholder="Defaults to the date — edit if you'd like to name it" />
          <Input label="Total production ($)" type="number" value={form.production} onChange={e=>setForm(f=>({...f,production:+e.target.value}))} />
          {pr?.deductsLabFees&&(
            <Input label="Lab fees ($)" type="number" value={form.labFees||0} onChange={e=>setForm(f=>({...f,labFees:+e.target.value}))} />
          )}
          <ToggleRow checked={!!form.isRedo} onChange={v=>setForm(f=>({...f,isRedo:v}))} icon="🔁" label="This includes a redo"
            sub="Redoing or remaking a prior procedure, usually at no charge to the patient" />
          {form.isRedo&&(
            <Input label="What's being redone (optional)" value={form.redoNotes||""} onChange={e=>setForm(f=>({...f,redoNotes:e.target.value}))} placeholder="e.g. crown remake, tooth #14" />
          )}
          {form.receipt&&(
            <div>
              <div style={{ fontSize:11,fontWeight:600,color:"#64748b",marginBottom:6,textTransform:"uppercase",letterSpacing:"0.05em" }}>Attachment</div>
              <Btn size="sm" variant="secondary" onClick={()=>setViewingReceipt(true)}>📎 View attached day sheet</Btn>
            </div>
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

// ── Global filter bar — shared by Home, Production, and Transactions ───────
const FilterBar = ({ period, setPeriod, practiceId, setPracticeId, practices }) => (
  <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center", marginBottom: 18 }}>
    <div style={{ display: "flex", gap: 2, background: "#f1f5f9", borderRadius: 10, padding: 3 }}>
      {["day", "week", "month", "year"].map(p => (
        <button key={p} onClick={() => setPeriod(p)} style={{ padding: "7px 14px", border: "none", borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: "pointer", background: period === p ? "#fff" : "transparent", color: period === p ? "#0F6E56" : "#64748b", boxShadow: period === p ? "0 1px 3px rgba(0,0,0,0.1)" : "none" }}>
          {PERIOD_LABELS[p]}
        </button>
      ))}
    </div>
    {practices.length > 0 && (
      <select value={practiceId || "all"} onChange={e => setPracticeId(e.target.value === "all" ? null : e.target.value)}
        style={{ padding: "8px 12px", border: "1px solid #e2e8f0", borderRadius: 8, fontSize: 13, color: "#1e293b", background: "#fff" }}>
        <option value="all">All practices</option>
        {practices.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
      </select>
    )}
  </div>
);

const HomeTab = ({ production, expenses, banks, chartProduction, chartBanks, filterPeriod, agreement, matches, practices, collectionsSummary, connectedAccounts, setConnectedAccounts, onTransactionsSynced, setTab, goToTransactions }) => {
  const [showEmail, setShowEmail] = useState(false);
  const [showTax, setShowTax]     = useState(false);
  const [showPlaid, setShowPlaid] = useState(false);
  const [bankPromptDismissed, setBankPromptDismissed] = useState(() => {
    try { return localStorage.getItem("dt_bank_prompt_dismissed") === "1"; } catch { return false; }
  });
  const dismissBankPrompt = () => {
    setBankPromptDismissed(true);
    try { localStorage.setItem("dt_bank_prompt_dismissed", "1"); } catch {}
  };

  const [dismissedBanners, setDismissedBanners] = useState(() => {
    try { return JSON.parse(localStorage.getItem("dt_home_dismissed_banners")||"[]"); } catch { return []; }
  });
  const [showDismissedMenu, setShowDismissedMenu] = useState(false);
  const dismissBanner = (key) => setDismissedBanners(prev => {
    const next = [...new Set([...prev, key])];
    try { localStorage.setItem("dt_home_dismissed_banners", JSON.stringify(next)); } catch {}
    return next;
  });
  const restoreBanner = (key) => setDismissedBanners(prev => {
    const next = prev.filter(k=>k!==key);
    try { localStorage.setItem("dt_home_dismissed_banners", JSON.stringify(next)); } catch {}
    return next;
  });
  useEffect(() => {
    if (!showDismissedMenu) return;
    const close = () => setShowDismissedMenu(false);
    document.addEventListener("click", close);
    return () => document.removeEventListener("click", close);
  }, [showDismissedMenu]);

  const totalProd   = production.reduce((s,r)=>s+r.production,0);
  const totalExp    = banks.reduce((s,b)=>s+deductibleAmount(b),0);
  const businessExp = banks.filter(b=>b.type==="business").reduce((s,b)=>s+Math.abs(b.amount),0);
  const deposits    = banks.filter(b=>b.type==="collection").reduce((s,b)=>s+b.amount,0);
  const collectionRate = totalProd>0 ? (deposits/totalProd)*100 : null;
  const expectedPay = computeExpectedPay(practices, production, banks);
  const variance = deposits>0 ? (deposits - expectedPay) : 0;
  const net = expectedPay - totalExp;

  // Financial performance chart — trailing buckets sized to the selected
  // global filter granularity, built from practice-filtered but NOT
  // period-filtered data so the chart always shows real history regardless
  // of which single period the stat cards above are currently zoomed to.
  const perfBuckets = periodBuckets(filterPeriod, PERIOD_BUCKET_COUNTS[filterPeriod] || 6);
  const perfSeries = perfBuckets.map(b => {
    const bucketProd  = (chartProduction||[]).filter(r=>dateInRange(r.date,b));
    const bucketBanks = (chartBanks||[]).filter(x=>dateInRange(x.date,b));
    return {
      label: b.label,
      production: bucketProd.reduce((s,r)=>s+r.production,0),
      collection: bucketBanks.filter(x=>x.type==="collection").reduce((s,x)=>s+x.amount,0),
      expectedPay: computeExpectedPay(practices, bucketProd, bucketBanks),
      expenses: bucketBanks.reduce((s,x)=>s+deductibleAmount(x),0),
    };
  });
  const perfMax = Math.max(1, ...perfSeries.flatMap(s=>[s.production,s.collection,s.expectedPay,s.expenses]));
  const PERF_SERIES_META = [["production","Production","#0F6E56"],["collection","Collection","#1e40af"],["expectedPay","Expected pay","#a855f7"],["expenses","Expenses","#f97316"]];

  const practiceBreakdown = practices.map(pr=>{
    const prDeps = banks.filter(b=>b.type==="collection"&&b.practiceId===pr.id).reduce((s,b)=>s+b.amount,0);
    const prLab  = pr.deductsLabFees ? production.filter(r=>r.practiceId===pr.id).reduce((s,r)=>s+(r.labFees||0),0) : 0;
    return { name: pr.name, deposits: prDeps, labFees: prLab, pay: Math.max(0, prDeps - prLab) * (pr.pct/100) };
  });
  const expenseByCategory = {};
  banks.forEach(b=>{
    if (b.splits && b.splits.length) {
      b.splits.forEach(sp=>{
        if (!sp.taxDeductible) return;
        const cat = sp.category || "Other";
        expenseByCategory[cat] = (expenseByCategory[cat]||0) + Math.abs(sp.amount)*(sp.deductibleFraction??1);
      });
    } else if (b.type==="business" && b.taxDeductible) {
      const cat = b.category || "Other";
      expenseByCategory[cat] = (expenseByCategory[cat]||0) + Math.abs(b.amount)*(b.deductibleFraction??1);
    }
  });
  const reportPeriod = new Date().toLocaleDateString(undefined,{ month:"long", year:"numeric" });

  const matchedExpIds  = new Set(matches.map(m=>m.expenseId));
  const matchedBankIds = new Set(matches.map(m=>m.bankId));
  const pendingExp     = expenses.filter(e=>e.taxDeductible&&!matchedExpIds.has(e.id));
  const missingReceipt = banks.filter(b=>b.amount<0&&b.type!=="personal"&&!matchedBankIds.has(b.id));

  return (
    <div style={{ display:"flex",flexDirection:"column",gap:20 }}>
      {showEmail&&<EmailReportModal agreement={agreement} period={reportPeriod} expectedPay={expectedPay} totalExp={totalExp} net={net} practiceBreakdown={practiceBreakdown} expenseByCategory={expenseByCategory} onClose={()=>setShowEmail(false)} />}
      {showTax&&<TaxPlanningModal defaultSalary={agreement.salary?agreement.salary*12:90000} onClose={()=>setShowTax(false)} />}
      {showPlaid&&<PlaidModal onConnect={accs=>setConnectedAccounts(a=>[...a,...accs.filter(na=>!a.find(x=>x.id===na.id))])} onTransactionsSynced={onTransactionsSynced} onClose={()=>setShowPlaid(false)} />}

      {/* Connect-your-bank nudge — shown after onboarding, once there's
          actually something on screen to point at, instead of asking for
          bank credentials before anyone's seen the app do anything. */}
      {!connectedAccounts?.length && !bankPromptDismissed && (
        <div style={{ background:"linear-gradient(135deg,#0F6E56,#0a4d3c)",border:"none",borderRadius:12,padding:"16px 20px",display:"flex",alignItems:"center",gap:14,flexWrap:"wrap" }}>
          <span style={{ fontSize:22 }}>🏦</span>
          <div style={{ flex:1,minWidth:200 }}>
            <div style={{ fontSize:13,fontWeight:700,color:"#fff" }}>Connect your bank to catch underpayments automatically</div>
            <div style={{ fontSize:12,color:"#a8e6cf" }}>Deposits import on their own and get matched against what you're owed — read-only, never moves money.</div>
          </div>
          <Btn onClick={()=>setShowPlaid(true)} style={{ background:"#fff",color:"#0F6E56" }}>Connect bank</Btn>
          <button onClick={dismissBankPrompt} title="Dismiss" style={{ background:"none",border:"none",color:"#a8e6cf",fontSize:16,cursor:"pointer",padding:4 }}>✕</button>
        </div>
      )}

      {dismissedBanners.length>0&&(
        <div style={{ position:"relative",display:"flex",justifyContent:"flex-end" }}>
          <button onClick={(e)=>{ e.stopPropagation(); setShowDismissedMenu(m=>!m); }} style={{ display:"flex",alignItems:"center",gap:6,background:"#f1f5f9",border:"none",borderRadius:99,padding:"6px 12px",fontSize:12,fontWeight:600,color:"#64748b",cursor:"pointer" }}>
            🔔 {dismissedBanners.length} hidden
          </button>
          {showDismissedMenu&&(
            <div onClick={e=>e.stopPropagation()} style={{ position:"absolute",top:34,right:0,width:260,background:"#fff",border:"1px solid #e2e8f0",borderRadius:10,boxShadow:"0 8px 24px rgba(0,0,0,0.12)",zIndex:150,overflow:"hidden" }}>
              <div style={{ padding:"10px 14px",borderBottom:"1px solid #f1f5f9",fontSize:12,fontWeight:600,color:"#64748b" }}>Hidden alerts</div>
              {[
                { key:"payVariance", label:"Expected pay alert" },
                { key:"receiptMatching", label:"Receipt matching alert" },
              ].filter(b=>dismissedBanners.includes(b.key)).map(b=>(
                <div key={b.key} style={{ display:"flex",justifyContent:"space-between",alignItems:"center",padding:"10px 14px",fontSize:13,color:"#334155" }}>
                  <span>{b.label}</span>
                  <button onClick={()=>restoreBanner(b.key)} style={{ background:"none",border:"none",color:"#0F6E56",fontWeight:600,fontSize:12,cursor:"pointer" }}>Show</button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Underpayment alert */}
      {Math.abs(variance)>50&&!dismissedBanners.includes("payVariance")&&(
        <div style={{ background:variance<0?"#fee2e2":"#dcfce7",border:"1px solid "+(variance<0?"#fca5a5":"#86efac"),borderRadius:10,padding:"12px 18px",display:"flex",alignItems:"center",gap:10 }}>
          <span>{variance<0?"⚠️":"✅"}</span>
          <div style={{ flex:1 }}>
            <div style={{ fontSize:13,fontWeight:700,color:variance<0?"#991b1b":"#166534" }}>
              {variance<0?"Possible underpayment of "+fmt(Math.abs(variance)):fmt(variance)+" ahead of expected pay"}
            </div>
            <div style={{ fontSize:12,color:variance<0?"#b91c1c":"#15803d" }}>Expected {fmt(expectedPay)} · Received {fmt(deposits)}</div>
          </div>
          <button onClick={()=>dismissBanner("payVariance")} title="Dismiss — find it again under 🔔 hidden" style={{ background:"none",border:"none",color:variance<0?"#991b1b":"#166534",fontSize:16,cursor:"pointer",padding:4,flexShrink:0 }}>✕</button>
        </div>
      )}

      {/* Receipt matching alert */}
      {(pendingExp.length>0||missingReceipt.length>0)&&!dismissedBanners.includes("receiptMatching")&&(
        <div style={{ background:"#fffbeb",border:"1px solid #fde68a",borderRadius:10,padding:"12px 18px",display:"flex",gap:10 }}>
          <span>🔗</span>
          <div style={{ flex:1 }}>
            <div style={{ fontSize:13,fontWeight:700,color:"#92400e",marginBottom:4 }}>Receipt matching needs attention</div>
            {pendingExp.length>0&&<div style={{ fontSize:12,color:"#b45309" }}>· {pendingExp.length} expense(s) not yet confirmed by bank</div>}
            {missingReceipt.length>0&&<div style={{ fontSize:12,color:"#b45309" }}>· {missingReceipt.length} bank debit(s) have no receipt on file</div>}
          </div>
          <button onClick={()=>dismissBanner("receiptMatching")} title="Dismiss — find it again under 🔔 hidden" style={{ background:"none",border:"none",color:"#92400e",fontSize:16,cursor:"pointer",padding:4,flexShrink:0 }}>✕</button>
        </div>
      )}

      {/* Stat cards */}
      <div style={{ display:"flex",gap:14,flexWrap:"wrap" }}>
        <StatCard label="Production"         value={fmt(totalProd)}   sub={"across "+practices.length+" practices"} color="#1e293b"
          onClick={()=>setTab?.("production")} />
        <StatCard label="Collection"         value={fmt(deposits)}    sub={deposits>0&&totalProd>0 ? pct(deposits,totalProd)+" of production" : "bank deposits received"} color="#1e293b"
          onClick={()=>goToTransactions?.("feed","collection")} />
        <StatCard label="Expected pay"       value={fmt(expectedPay)} sub="based on deposits"                       color="#1e293b"
          onClick={()=>goToTransactions?.("reconcile")} />
        <StatCard label="Collection rate"    value={collectionRate!==null?collectionRate.toFixed(0)+"%":"—"} sub="deposits ÷ production" color="#1e293b"
          onClick={()=>goToTransactions?.("reconcile")} />
        <StatCard label="Business expenses"  value={fmt(businessExp)} sub={matches.length+" receipts matched"}       color="#1e293b"
          onClick={()=>goToTransactions?.("feed")} />
        <StatCard label="Tax deductibles"    value={fmt(totalExp)}    sub="deductible this period"                   color="#1e293b"
          onClick={()=>goToTransactions?.("deductibles")} />
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

      {/* Financial performance chart */}
      <Card>
        <div style={{ fontSize:14,fontWeight:600,color:"#1e293b",marginBottom:4 }}>Financial performance</div>
        <div style={{ display:"flex",gap:14,flexWrap:"wrap",margin:"10px 0 16px" }}>
          {PERF_SERIES_META.map(([key,label,color])=>(
            <div key={key} style={{ display:"flex",alignItems:"center",gap:6,fontSize:11,color:"#64748b" }}>
              <div style={{ width:8,height:8,borderRadius:2,background:color }} />{label}
            </div>
          ))}
        </div>
        <div style={{ display:"flex",alignItems:"flex-end",gap:16,height:130 }}>
          {perfSeries.map((s,i)=>(
            <div key={i} style={{ flex:1,display:"flex",flexDirection:"column",alignItems:"center",gap:6,minWidth:0 }}>
              <div style={{ display:"flex",alignItems:"flex-end",gap:3,height:100,width:"100%",justifyContent:"center" }}>
                {PERF_SERIES_META.map(([key,label,color])=>(
                  <div key={key} title={`${label}: ${fmt(s[key])}`} style={{ width:8,background:color,borderRadius:"3px 3px 0 0",height:Math.max(2,(s[key]/perfMax)*94) }} />
                ))}
              </div>
              <div style={{ fontSize:10,color:"#94a3b8" }}>{s.label}</div>
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
const ProductionTab = ({ production, setProduction, practices, filterPeriod }) => {
  const [showLog, setShowLog]     = useState(false);
  const [editEntry, setEditEntry] = useState(null);
  const [viewingReceipt, setViewingReceipt] = useState(null);

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
      {viewingReceipt&&<ReceiptViewer receipt={viewingReceipt} onClose={()=>setViewingReceipt(null)}/>}

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
          <div style={{ fontSize:12,color:"#94a3b8",textAlign:"right" }}>
            {production.length} entries this {(PERIOD_LABELS[filterPeriod]||"Month").toLowerCase()}
            {production.some(e=>e.isRedo) && (
              <div style={{ marginTop:2 }}>
                includes {fmt(production.filter(e=>e.isRedo).reduce((s,e)=>s+e.production,0))} in redos — not separated out of production below yet
              </div>
            )}
          </div>
        </div>
        {production.length===0 ? (
          <div style={{ padding:"40px 20px",textAlign:"center",color:"#94a3b8",fontSize:13 }}>
            <div style={{ fontSize:32,marginBottom:10 }}>📋</div>
            No production logged yet — tap "Log production" above.
          </div>
        ) : (
          [...production].sort((a,b)=>b.date.localeCompare(a.date)).map((entry,i)=>{
            const pr = practices.find(p=>p.id===entry.practiceId);
            const showsDateSeparately = entry.label && entry.label !== entry.date;
            return (
              <div key={entry.id} style={{ display:"flex",flexDirection:"column",gap:8,padding:"12px 20px",borderBottom:"1px solid #f8fafc",background:i%2===0?"#fff":"#fafafa" }}>
                <div style={{ display:"flex",alignItems:"center",gap:8,flexWrap:"wrap" }}>
                  <div style={{ width:8,height:8,borderRadius:"50%",background:pr?.color||"#e2e8f0",flexShrink:0 }} />
                  <span style={{ fontSize:13,fontWeight:600,color:"#1e293b",whiteSpace:"nowrap" }}>{entry.label||entry.date}</span>
                  {showsDateSeparately&&<span style={{ fontSize:11,color:"#94a3b8",whiteSpace:"nowrap" }}>{entry.date}</span>}
                  <span style={{ fontSize:12,color:"#64748b",whiteSpace:"nowrap" }}>{pr?.name||"—"}</span>
                  {entry.labFees>0&&<span style={{ fontSize:11,color:"#92400e",background:"#fef3c7",padding:"1px 6px",borderRadius:99,whiteSpace:"nowrap" }}>Lab: {fmt(entry.labFees)}</span>}
                  <Badge label={entry.source==="daysheet"?"📋 Day sheet":"Manual"} color={entry.source==="daysheet"?"teal":"gray"} />
                  {entry.isRedo&&<Badge label="🔁 Redo" color="amber" />}
                </div>
                {entry.isRedo&&entry.redoNotes&&<div style={{ fontSize:12,color:"#92400e",fontStyle:"italic" }}>Redo: {entry.redoNotes}</div>}
                <div style={{ display:"flex",alignItems:"center",justifyContent:"space-between",gap:8,flexWrap:"wrap" }}>
                  <div style={{ fontSize:16,fontWeight:700,color:"#1e293b",whiteSpace:"nowrap" }}>{fmt(entry.production)}</div>
                  <div style={{ display:"flex",gap:6,flexShrink:0,flexWrap:"wrap" }}>
                    {entry.receipt&&<Btn variant="secondary" size="sm" onClick={()=>setViewingReceipt(entry.receipt)}>📎 View</Btn>}
                    <Btn variant="ghost" size="sm" onClick={()=>setEditEntry(entry)}>Edit</Btn>
                    <Btn variant="danger" size="sm" onClick={()=>setProduction(p=>p.filter(x=>x.id!==entry.id))}>Remove</Btn>
                  </div>
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
// Shows a previously-attached receipt. Handles the case where an older
// entry only has a boolean "receipt: true" flag with no actual image saved
// (from before receipts stored the real photo) gracefully instead of breaking.
const ReceiptViewer = ({ receipt, onClose }) => {
  const hasImage = receipt && typeof receipt === "object" && receipt.imageBase64;
  return (
    <div className="dt-modal-overlay" style={{ position:"fixed",inset:0,background:"rgba(0,0,0,0.6)",display:"flex",alignItems:"center",justifyContent:"center",zIndex:1300 }}>
      <Card style={{ width:420,maxHeight:"90vh",overflowY:"auto",padding:24 }}>
        <div style={{ display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:16 }}>
          <div style={{ fontSize:16,fontWeight:700,color:"#1e293b" }}>Attached receipt</div>
          <Btn variant="ghost" size="sm" onClick={onClose}>Close</Btn>
        </div>
        {hasImage ? (
          <>
            <img src={`data:${receipt.mimeType||"image/jpeg"};base64,${receipt.imageBase64}`} alt="Receipt"
              style={{ width:"100%",borderRadius:10,border:"1px solid #e2e8f0",marginBottom:14 }} />
            {(receipt.vendor||receipt.date||receipt.amount)&&(
              <div style={{ display:"flex",flexDirection:"column",gap:4,fontSize:13,color:"#475569" }}>
                {receipt.vendor&&<div><strong>Vendor:</strong> {receipt.vendor}</div>}
                {receipt.date&&<div><strong>Date:</strong> {receipt.date}</div>}
                {receipt.amount!=null&&<div><strong>Amount:</strong> ${receipt.amount}</div>}
              </div>
            )}
          </>
        ) : (
          <div style={{ textAlign:"center",padding:"24px 12px",color:"#94a3b8",fontSize:13 }}>
            This was marked as having a receipt, but no image was saved for it — that happened before receipt photos were kept on file. New receipts you scan or attach from here on will be viewable like this.
          </div>
        )}
      </Card>
    </div>
  );
};

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
      setError(e.message || "Couldn't read the receipt — try a clearer photo.");
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
            <div style={{ background:"#f0fdf4",border:"1px solid #bbf7d0",borderRadius:10,padding:"14px 16px",marginBottom:10 }}>
              <div style={{ fontSize:12,color:"#166534",fontWeight:600,marginBottom:8 }}>Receipt extracted — fix anything wrong below</div>
              <div style={{ display:"flex",flexDirection:"column",gap:8 }}>
                <div>
                  <div style={{ fontSize:11,color:"#64748b",marginBottom:3 }}>Vendor</div>
                  <input value={result.vendor||""} onChange={e=>setResult(r=>({...r,vendor:e.target.value}))}
                    style={{ width:"100%",boxSizing:"border-box",padding:"7px 10px",border:"1px solid #e2e8f0",borderRadius:7,fontSize:13 }}/>
                </div>
                <div>
                  <div style={{ fontSize:11,color:"#64748b",marginBottom:3 }}>Date</div>
                  <input type="date" value={result.date||""} onChange={e=>setResult(r=>({...r,date:e.target.value}))}
                    style={{ width:"100%",boxSizing:"border-box",padding:"7px 10px",border:"1px solid #e2e8f0",borderRadius:7,fontSize:13 }}/>
                </div>
                <div>
                  <div style={{ fontSize:11,color:"#64748b",marginBottom:3 }}>Amount ($)</div>
                  <input type="number" value={result.amount??""} onChange={e=>setResult(r=>({...r,amount:e.target.value?+e.target.value:""}))}
                    style={{ width:"100%",boxSizing:"border-box",padding:"7px 10px",border:"1px solid #e2e8f0",borderRadius:7,fontSize:13 }}/>
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
  const [receiptImg, setReceiptImg] = useState(null); // {imageBase64, mimeType} once scanned
  const [showScan, setShowScan] = useState(false);
  const cat = getCategory(form.category);

  return(
    <div className="dt-modal-overlay" style={{ position:"fixed",inset:0,background:"rgba(0,0,0,0.5)",display:"flex",alignItems:"center",justifyContent:"center",zIndex:1001 }}>
      {showScan&&<ScanModal title="Scan Receipt"
        prompt='Extract from this receipt: vendor name, date (YYYY-MM-DD), total amount (number). Respond as JSON with keys vendor, date, amount.'
        onClose={()=>setShowScan(false)}
        onResult={(r, img)=>{
          setForm(f=>({
            ...f,
            description: r.vendor || f.description,
            date: r.date || f.date,
            amount: r.amount!=null ? +r.amount : f.amount,
          }));
          setReceiptImg(img || null);
        }} />}
      <Card className="dt-modal-card" style={{ width:460,padding:28,overflowY:"auto",maxHeight:"90vh" }}>
        <div style={{ display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:20 }}>
          <div>
            <div style={{ fontSize:16,fontWeight:700,color:"#1e293b" }}>Add manual expense</div>
            <div style={{ fontSize:12,color:"#94a3b8",marginTop:2 }}>For cash or off-card purchases not in your bank feed</div>
          </div>
          <Btn variant="ghost" size="sm" onClick={onClose}>Close</Btn>
        </div>
        <div style={{ display:"flex",flexDirection:"column",gap:14 }}>
          <button onClick={()=>setShowScan(true)} style={{ display:"flex",alignItems:"center",gap:6,background:"none",border:"1px dashed #cbd5e1",borderRadius:8,padding:"8px 10px",fontSize:12,fontWeight:600,color:"#0F6E56",cursor:"pointer",width:"fit-content" }}>📷 Scan receipt to autofill</button>
          {receiptImg&&<div style={{ fontSize:12,color:"#166534" }}>✓ Receipt scanned — details filled in below, edit anything before saving</div>}
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
                receipt: receiptImg ? { ...receiptImg, vendor:form.description, date:form.date, amount:form.amount } : null,
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

const TransactionsTab = ({ expenses, setExpenses, banks, setBanks, tagBank, agreement, matches, practices, production, bankRules, addRule, duplicateIds, connectedAccounts, isMobile, sub, setSub, typeFilter, setTypeFilter, globalPeriod, globalPracticeId }) => {
  const [pendingRule, setPendingRule]     = useState(null);
  const [expandedId, setExpandedId]       = useState(null);
  const [scanningFor, setScanningFor]     = useState(null); // bankId to attach receipt to
  const [viewingReceipt, setViewingReceipt] = useState(null); // receipt object currently being viewed
  const [showManual, setShowManual]       = useState(false);
  const [splittingId, setSplittingId]     = useState(null); // bankId currently being split-edited
  const [splitDraft, setSplitDraft]       = useState([]);   // [{id,category,amount}] while editing
  const [monthFilter, setMonthFilter]     = useState("all");
  const [dismissedBanners, setDismissedBanners] = useState(() => {
    try { return JSON.parse(localStorage.getItem("dt_dismissed_banners")||"[]"); } catch { return []; }
  });
  const [showDismissedMenu, setShowDismissedMenu] = useState(false);
  const [selectMode, setSelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState(new Set());
  const toggleSelected = (id) => setSelectedIds(prev => {
    const next = new Set(prev);
    next.has(id) ? next.delete(id) : next.add(id);
    return next;
  });
  const exitSelectMode = () => { setSelectMode(false); setSelectedIds(new Set()); };
  const dismissBanner = (key) => setDismissedBanners(prev => {
    const next = [...new Set([...prev, key])];
    try { localStorage.setItem("dt_dismissed_banners", JSON.stringify(next)); } catch {}
    return next;
  });
  const restoreBanner = (key) => setDismissedBanners(prev => {
    const next = prev.filter(k=>k!==key);
    try { localStorage.setItem("dt_dismissed_banners", JSON.stringify(next)); } catch {}
    return next;
  });
  useEffect(() => {
    if (!showDismissedMenu) return;
    const close = () => setShowDismissedMenu(false);
    document.addEventListener("click", close);
    return () => document.removeEventListener("click", close);
  }, [showDismissedMenu]);
  const [accountFilter, setAccountFilter] = useState("all");

  const SUBS = [
    { key:"all",         label:"All" },
    { key:"feed",        label:"Feed" },
    { key:"deductibles", label:"Deductibles" },
    { key:"reconcile",   label:"Reconciliation" },
  ];

  // Months present in the data, newest first — independent of the current
  // filter selection, so switching months never hides other months from the list.
  const availableMonths = Array.from(new Set(banks.map(b=>b.date.slice(0,7)))).sort().reverse();
  const monthLabel = (ym) => {
    const [y,m] = ym.split("-");
    return new Date(+y, +m-1, 1).toLocaleDateString(undefined,{ month:"long", year:"numeric" });
  };

  // Global Day/Week/Month/Year + practice filter, layered on top of this
  // tab's own month/account filters (which stay independent, per the note
  // on availableMonths above — the global filter narrows first).
  const globalRange = periodRange(globalPeriod);
  const matchesGlobal = (row) => (!globalPracticeId || row.practiceId===globalPracticeId) && dateInRange(row.date, globalRange);
  const globalBanks = banks.filter(matchesGlobal);
  const globalProduction = production.filter(matchesGlobal);
  const globalPractices = globalPracticeId ? practices.filter(p=>p.id===globalPracticeId) : practices;

  const filteredBanks = globalBanks.filter(b=>
    (monthFilter==="all" || b.date.slice(0,7)===monthFilter) &&
    (accountFilter==="all" || (accountFilter==="manual" ? !b.plaidAccountId : b.plaidAccountId===accountFilter))
  );

  const bankStatus = (b) => { if(b.amount>0||b.type==="personal"||b.type==="transfer") return null; return b.receipt?"matched":"no-receipt"; };
  const bizExp     = filteredBanks.reduce((s,b)=>s+deductibleAmount(b),0);
  const bizCount   = filteredBanks.filter(b=>deductibleAmount(b)>0).length;
  const deposits   = filteredBanks.filter(b=>b.type==="collection").reduce((s,b)=>s+b.amount,0);
  const missingReceiptCount = filteredBanks.filter(b=>deductibleAmount(b)>0&&!b.receipt).length;
  const duplicateCount = filteredBanks.filter(b=>duplicateIds?.has(b.id)&&!b.reviewed).length;

  return (
    <div style={{ display:"flex",flexDirection:"column",gap:20 }}>
      {scanningFor&&<ReceiptScanner bankId={scanningFor}
        onAttach={r=>{ setBanks(bk=>bk.map(x=>x.id===scanningFor?{...x,receipt:r}:x)); setScanningFor(null); }}
        onClose={()=>setScanningFor(null)}/>}
      {viewingReceipt&&<ReceiptViewer receipt={viewingReceipt} onClose={()=>setViewingReceipt(null)}/>}
      {showManual&&<ManualExpenseModal agreement={agreement}
        onSave={tx=>{ setBanks(bk=>[...bk,tx]); setShowManual(false); }}
        onClose={()=>setShowManual(false)}/>}

      <div style={{ display:"flex",justifyContent:"space-between",alignItems:"center",flexWrap:"wrap",gap:10 }}>
        <div style={{ display:"flex",gap:2,background:"#f1f5f9",borderRadius:10,padding:3,overflowX:"auto" }}>
          {SUBS.map(s=>(
            <button key={s.key} onClick={()=>{ setSub(s.key); setTypeFilter(null); }} style={{ padding:"7px 16px",border:"none",borderRadius:8,fontSize:13,fontWeight:600,cursor:"pointer",whiteSpace:"nowrap",background:sub===s.key?"#fff":"transparent",color:sub===s.key?"#0F6E56":"#64748b",boxShadow:sub===s.key?"0 1px 3px rgba(0,0,0,0.1)":"none" }}>{s.label}</button>
          ))}
        </div>
        <Btn variant="ghost" size="sm" onClick={()=>setShowManual(true)}>+ Manual expense</Btn>
      </div>

      <div style={{ display:"flex",gap:10,flexWrap:"wrap" }}>
        <select value={monthFilter} onChange={e=>setMonthFilter(e.target.value)}
          style={{ padding:"8px 12px",border:"1px solid #e2e8f0",borderRadius:8,fontSize:13,color:"#1e293b",background:"#fff" }}>
          <option value="all">All months</option>
          {availableMonths.map(ym=><option key={ym} value={ym}>{monthLabel(ym)}</option>)}
        </select>
        <select value={accountFilter} onChange={e=>setAccountFilter(e.target.value)}
          style={{ padding:"8px 12px",border:"1px solid #e2e8f0",borderRadius:8,fontSize:13,color:"#1e293b",background:"#fff" }}>
          <option value="all">All accounts</option>
          {(connectedAccounts||[]).map(acc=>(
            <option key={acc.plaidAccountId||acc.id} value={acc.plaidAccountId}>{acc.name} ···{acc.mask}</option>
          ))}
          <option value="manual">Manual entries</option>
        </select>
        {(monthFilter!=="all"||accountFilter!=="all")&&(
          <button onClick={()=>{ setMonthFilter("all"); setAccountFilter("all"); }}
            style={{ background:"none",border:"none",color:"#0F6E56",fontSize:13,fontWeight:600,cursor:"pointer" }}>
            Clear filters
          </button>
        )}
      </div>

      <div style={{ display:"flex",gap:14,flexWrap:"wrap" }}>
        <StatCard label="Deductible total"   value={fmt(bizExp)}   sub={bizCount+" transactions"} color="#1e293b"
          onClick={()=>{ setSub("deductibles"); setTypeFilter(null); }}/>
        <StatCard label="Collections banked" value={fmt(deposits)} sub={practices.length+" practices"} color="#1e293b"
          onClick={()=>{ setSub("feed"); setTypeFilter("collection"); }}/>
        <StatCard label="Missing receipts"   value={String(missingReceiptCount)} sub="deductibles without documentation" color={missingReceiptCount>0?"#991b1b":"#1e293b"}
          onClick={()=>{ setSub("deductibles"); setTypeFilter("missingReceipts"); }}/>
      </div>

      {typeFilter&&(
        <div style={{ display:"flex",alignItems:"center",gap:10,background:"#E1F5EE",border:"1px solid #bbf7d0",borderRadius:10,padding:"10px 16px" }}>
          <span style={{ fontSize:13,color:"#0F6E56",fontWeight:600 }}>
            Showing: {typeFilter==="collection"?"Collections only":typeFilter==="duplicates"?"Possible duplicates only":"Missing receipts only"}
          </span>
          <button onClick={()=>{ setTypeFilter(null); setSub("all"); }} style={{ marginLeft:"auto",background:"none",border:"none",color:"#0F6E56",fontSize:13,fontWeight:600,cursor:"pointer",display:"flex",alignItems:"center",gap:4 }}>
            ← Back to all
          </button>
        </div>
      )}

      {dismissedBanners.length>0&&(
        <div style={{ position:"relative",display:"flex",justifyContent:"flex-end" }}>
          <button onClick={(e)=>{ e.stopPropagation(); setShowDismissedMenu(m=>!m); }} style={{ display:"flex",alignItems:"center",gap:6,background:"#f1f5f9",border:"none",borderRadius:99,padding:"6px 12px",fontSize:12,fontWeight:600,color:"#64748b",cursor:"pointer" }}>
            🔔 {dismissedBanners.length} hidden
          </button>
          {showDismissedMenu&&(
            <div onClick={e=>e.stopPropagation()} style={{ position:"absolute",top:34,right:0,width:260,background:"#fff",border:"1px solid #e2e8f0",borderRadius:10,boxShadow:"0 8px 24px rgba(0,0,0,0.12)",zIndex:150,overflow:"hidden" }}>
              <div style={{ padding:"10px 14px",borderBottom:"1px solid #f1f5f9",fontSize:12,fontWeight:600,color:"#64748b" }}>Hidden alerts</div>
              {[
                { key:"duplicates", label:"Possible duplicates warning" },
                { key:"missingReceipts", label:"Missing receipts reminder" },
              ].filter(b=>dismissedBanners.includes(b.key)).map(b=>(
                <div key={b.key} style={{ display:"flex",justifyContent:"space-between",alignItems:"center",padding:"10px 14px",fontSize:13,color:"#334155" }}>
                  <span>{b.label}</span>
                  <button onClick={()=>{ restoreBanner(b.key); }} style={{ background:"none",border:"none",color:"#0F6E56",fontWeight:600,fontSize:12,cursor:"pointer" }}>Show</button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {duplicateCount>0&&!dismissedBanners.includes("duplicates")&&(
        <div style={{ background:"#fef2f2",border:"1px solid #fecaca",borderRadius:10,padding:"12px 18px",display:"flex",alignItems:"center",gap:10 }}>
          <span>⚠️</span>
          <div onClick={()=>{ setSub("feed"); setTypeFilter("duplicates"); }} style={{ flex:1,cursor:"pointer" }}>
            <div style={{ fontSize:13,fontWeight:700,color:"#991b1b" }}>{duplicateCount} transactions look like possible duplicates</div>
            <div style={{ fontSize:12,color:"#b91c1c" }}>Same amount, same day (±1) as another transaction. Marked with ⚠ below — review before counting both. Tap to view them.</div>
          </div>
          <button onClick={()=>dismissBanner("duplicates")} title="Dismiss — find it again under 🔔 hidden" style={{ background:"none",border:"none",color:"#991b1b",fontSize:16,cursor:"pointer",padding:4,flexShrink:0 }}>✕</button>
        </div>
      )}

      {missingReceiptCount>0&&!dismissedBanners.includes("missingReceipts")&&(
        <div style={{ background:"#fffbeb",border:"1px solid #fde68a",borderRadius:10,padding:"12px 18px",display:"flex",alignItems:"center",gap:10 }}>
          <span>📄</span>
          <div onClick={()=>{ setSub("deductibles"); setTypeFilter("missingReceipts"); }} style={{ flex:1,cursor:"pointer" }}>
            <div style={{ fontSize:13,fontWeight:700,color:"#92400e" }}>{missingReceiptCount} deductible transactions missing a receipt</div>
            <div style={{ fontSize:12,color:"#b45309" }}>CRA requires receipts for all business expense claims. Tap to review.</div>
          </div>
          <span onClick={()=>{ setSub("deductibles"); setTypeFilter("missingReceipts"); }} style={{ fontSize:12,color:"#92400e",fontWeight:600,whiteSpace:"nowrap",cursor:"pointer" }}>Review →</span>
          <button onClick={()=>dismissBanner("missingReceipts")} title="Dismiss — find it again under 🔔 hidden" style={{ background:"none",border:"none",color:"#92400e",fontSize:16,cursor:"pointer",padding:4,flexShrink:0 }}>✕</button>
        </div>
      )}

      {(sub==="all"||sub==="feed")&&(
        <Card style={{ padding:0,overflow:"hidden" }}>
          {/* Feed header */}
          <div style={{ padding:"14px 20px",borderBottom:"1px solid #f1f5f9",background:"#f8fafc" }}>
            <div style={{ display:"flex",justifyContent:"space-between",alignItems:"center",flexWrap:"wrap",gap:10 }}>
              <div>
                <div style={{ fontSize:13,fontWeight:600,color:"#1e293b" }}>Bank feed</div>
                <div style={{ fontSize:11,color:"#94a3b8",marginTop:2 }}>
                  {filteredBanks.filter(b=>!b.reviewed&&!b.userTagged).length > 0
                    ? `${filteredBanks.filter(b=>!b.reviewed&&!b.userTagged).length} unreviewed — click any row to tag`
                    : "All transactions reviewed"}
                </div>
              </div>
              <div style={{ display:"flex",gap:8,alignItems:"center",flexWrap:"wrap" }}>
                <Btn size="sm" variant="secondary" onClick={()=>{ const ids=new Set(filteredBanks.map(x=>x.id)); setBanks(bk=>bk.map(x=>ids.has(x.id)?{...x,reviewed:true}:x)); }}>✓ Mark all reviewed</Btn>
                <Btn size="sm" variant="ghost" onClick={()=>{ const ids=new Set(filteredBanks.map(x=>x.id)); setBanks(bk=>bk.map(x=>ids.has(x.id)?{...x,reviewed:false}:x)); }}>↩ Mark all unreviewed</Btn>
                <Btn size="sm" variant={selectMode?"primary":"ghost"} onClick={()=>selectMode?exitSelectMode():setSelectMode(true)}>{selectMode?"✓ Done":"☑ Select"}</Btn>
                <Badge label="Live sync" color="green"/>
              </div>
            </div>

            {selectMode&&(
              <div style={{ display:"flex",alignItems:"center",gap:10,flexWrap:"wrap",marginTop:12,paddingTop:12,paddingBottom:12,borderTop:"1px solid #e2e8f0",
                position:"sticky",top:64,zIndex:90,background:"#fff",marginLeft:-20,marginRight:-20,paddingLeft:20,paddingRight:20,boxShadow:"0 4px 10px rgba(0,0,0,0.04)" }}>
                <button
                  onClick={()=>setSelectedIds(prev => prev.size===filteredBanks.length ? new Set() : new Set(filteredBanks.map(x=>x.id)))}
                  style={{ fontSize:12,fontWeight:600,color:"#0F6E56",background:"none",border:"none",cursor:"pointer",padding:0 }}>
                  {selectedIds.size===filteredBanks.length&&filteredBanks.length>0 ? "Deselect all" : "Select all"}
                </button>
                <span style={{ fontSize:12,color:"#94a3b8" }}>{selectedIds.size} selected</span>
                {selectedIds.size>0&&(
                  <div style={{ display:"flex",gap:8,flexWrap:"wrap",alignItems:"center" }}>
                    <Btn size="sm" variant="secondary" onClick={()=>{ setBanks(bk=>bk.map(x=>selectedIds.has(x.id)?{...x,reviewed:true}:x)); }}>✓ Mark reviewed</Btn>
                    <Btn size="sm" variant="ghost" onClick={()=>{ setBanks(bk=>bk.map(x=>selectedIds.has(x.id)?{...x,reviewed:false}:x)); }}>↩ Unmark reviewed</Btn>
                    <Btn size="sm" variant="ghost" onClick={()=>{ setBanks(bk=>bk.map(x=>selectedIds.has(x.id)?{...x,type:"personal",userTagged:true,reviewed:true}:x)); }}>Tag personal</Btn>
                    <select value="" onChange={e=>{
                        if(!e.target.value) return;
                        const cat = getCategory(e.target.value);
                        setBanks(bk=>bk.map(x=>selectedIds.has(x.id)?{...x,type:"business",category:cat.label,taxDeductible:cat.deductible,deductibleFraction:cat.fraction,corpExpense:agreement.isCorp&&cat.deductible,userTagged:true,reviewed:true}:x));
                        e.target.value="";
                      }}
                      style={{ padding:"7px 10px",border:"1px solid #e2e8f0",borderRadius:8,fontSize:12,fontWeight:600,color:"#334155",background:"#fff",cursor:"pointer" }}>
                      <option value="">Tag as category…</option>
                      {EXPENSE_CAT_LABELS.map(c=><option key={c} value={c}>{c}</option>)}
                    </select>
                    <Btn size="sm" variant="ghost" onClick={()=>{ setBanks(bk=>bk.map(x=>selectedIds.has(x.id)?{...x,type:"review",userTagged:false,autoTagged:false,reviewed:false,matchedRule:null}:x)); }}>Clear tag</Btn>
                    <Btn size="sm" variant="danger" onClick={()=>{
                      if(window.confirm(`Delete ${selectedIds.size} transaction${selectedIds.size!==1?"s":""}? This can't be undone.`)){
                        setBanks(bk=>bk.filter(x=>!selectedIds.has(x.id)));
                        exitSelectMode();
                      }
                    }}>🗑 Delete</Btn>
                  </div>
                )}
                <Btn size="sm" onClick={exitSelectMode} style={{ marginLeft:"auto" }}>✓ Done</Btn>
              </div>
            )}
            {/* Color legend */}
            <div style={{ display:"flex",gap:16,flexWrap:"wrap",marginTop:10,paddingTop:10,borderTop:"1px solid #e2e8f0" }}>
              <div style={{ display:"flex",alignItems:"center",gap:6,fontSize:11,color:"#64748b" }}>
                <div style={{ width:7,height:7,borderRadius:"50%",background:"#f59e0b" }}/> Needs review
              </div>
              <div style={{ display:"flex",alignItems:"center",gap:6,fontSize:11,color:"#64748b" }}>
                <div style={{ width:7,height:7,borderRadius:"50%",background:"#3b82f6" }}/> Auto-tagged — worth double-checking
              </div>
              <div style={{ display:"flex",alignItems:"center",gap:6,fontSize:11,color:"#64748b" }}>
                <div style={{ width:7,height:7,borderRadius:"50%",background:"#e2e8f0" }}/> Tagged by you
              </div>
              <div style={{ display:"flex",alignItems:"center",gap:6,fontSize:11,color:"#64748b" }}>
                <div style={{ width:10,height:10,borderRadius:"50%",background:"#94a3b8",opacity:0.5 }}/> Faded = marked reviewed
              </div>
            </div>
          </div>

          {/* Unified transaction list — all transactions, click to expand */}
          <div>
            {[...filteredBanks].filter(b=>(typeFilter!=="collection"||b.type==="collection")&&(typeFilter!=="duplicates"||duplicateIds?.has(b.id))).sort((a,b)=>b.date.localeCompare(a.date)).map((b,i)=>{
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
                    onClick={()=>selectMode ? toggleSelected(b.id) : setExpandedId(isOpen ? null : b.id)}
                    style={{ display:"flex",alignItems:"center",gap:12,padding:"12px 20px",
                      borderBottom: isOpen ? "none" : "1px solid #f1f5f9",
                      borderLeft:"3px solid "+(selectedIds.has(b.id)?"#0F6E56":borderColor),
                      background: selectedIds.has(b.id) ? "#E1F5EE" : isOpen ? "#f8fafc" : i%2===0?"#fff":"#fafafa",
                      opacity: b.reviewed && !selectMode ? 0.5 : 1,
                      filter: b.reviewed && !selectMode ? "grayscale(1)" : "none",
                      transition:"opacity 0.2s, filter 0.2s",
                      cursor:"pointer",userSelect:"none" }}>
                    {/* Checkbox (select mode) or status dot */}
                    {selectMode ? (
                      <input type="checkbox" checked={selectedIds.has(b.id)} onChange={()=>toggleSelected(b.id)} onClick={e=>e.stopPropagation()}
                        style={{ width:16,height:16,flexShrink:0,accentColor:"#0F6E56",cursor:"pointer" }} />
                    ) : (
                      <div style={{ width:7,height:7,borderRadius:"50%",flexShrink:0,
                        background: !isTagged?"#f59e0b":b.autoTagged?"#3b82f6":"#e2e8f0" }} />
                    )}

                    {/* Description + meta */}
                    <div style={{ flex:1,minWidth:0 }}>
                      <div style={{ fontSize:13,fontWeight:500,color:"#1e293b",display:"flex",alignItems:"center",gap:8,flexWrap:"wrap" }}>
                        {cleanMerchantName(b.description)}
                        {b.autoTagged&&!b.userTagged&&<span style={{ fontSize:10,color:"#3b82f6",fontWeight:600,background:"#eff6ff",padding:"1px 6px",borderRadius:99 }}>✨ Auto-tagged</span>}
                        {duplicateIds?.has(b.id)&&!b.reviewed&&<span style={{ fontSize:10,color:"#991b1b",fontWeight:600,background:"#fef2f2",padding:"1px 6px",borderRadius:99 }}>⚠ Possible duplicate</span>}
                      </div>
                      <div style={{ fontSize:11,color:"#94a3b8",marginTop:2,display:"flex",gap:10,flexWrap:"wrap" }}>
                        <span style={{ whiteSpace:"nowrap" }}>{b.date}</span>
                        {pr&&<PracticeDot color={pr.color} name={pr.name}/>}
                        {b.type==="collection"&&<Badge label="💰 Collection" color="green"/>}
                        {b.type==="business"&&<Badge label={b.splits?.length ? `Split (${b.splits.length})` : (b.category||"Business")} color="teal"/>}
                        {b.type==="personal"&&<Badge label="Personal" color="gray"/>}
                        {b.type==="transfer"&&<Badge label="🔁 Transfer" color="blue"/>}
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
                              {v:"transfer",   l:"🔁 Transfer between accounts"},
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
                        {b.type==="business"&&!b.splits?.length&&(
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
                            <button onClick={()=>{ setSplitDraft([{id:newId(),category:b.category||"",amount:Math.abs(b.amount)},{id:newId(),category:"",amount:0}]); setSplittingId(b.id); }}
                              style={{ marginTop:6,background:"none",border:"none",color:"#0F6E56",fontSize:11,fontWeight:600,cursor:"pointer",padding:0 }}>
                              Split into multiple categories
                            </button>
                          </div>
                        )}

                        {/* Split editor / summary */}
                        {b.type==="business"&&splittingId!==b.id&&b.splits?.length>0&&(
                          <div style={{ minWidth:220 }}>
                            <div style={{ fontSize:11,fontWeight:600,color:"#64748b",marginBottom:6,textTransform:"uppercase",letterSpacing:"0.05em" }}>Split ({b.splits.length})</div>
                            <div style={{ display:"flex",flexDirection:"column",gap:3 }}>
                              {b.splits.map(sp=>(
                                <div key={sp.id} style={{ fontSize:12,color:"#334155",display:"flex",justifyContent:"space-between",gap:8 }}>
                                  <span>{sp.category||"Uncategorized"}</span>
                                  <span style={{ fontWeight:600 }}>{fmtFull(sp.amount)}</span>
                                </div>
                              ))}
                            </div>
                            <div style={{ display:"flex",gap:10,marginTop:6 }}>
                              <button onClick={()=>{ setSplitDraft(b.splits.map(sp=>({...sp}))); setSplittingId(b.id); }} style={{ background:"none",border:"none",color:"#0F6E56",fontSize:11,fontWeight:600,cursor:"pointer",padding:0 }}>Edit split</button>
                              <button onClick={()=>tagBank(b.id,{...b,splits:null,reviewed:true})} style={{ background:"none",border:"none",color:"#94a3b8",fontSize:11,cursor:"pointer",padding:0 }}>Remove split</button>
                            </div>
                          </div>
                        )}

                        {b.type==="business"&&splittingId===b.id&&(()=>{
                          const total     = Math.abs(b.amount);
                          const allocated = splitDraft.reduce((s,sp)=>s+(+sp.amount||0),0);
                          const remaining = +(total-allocated).toFixed(2);
                          return (
                            <div style={{ minWidth:280,background:"#fff",border:"1px solid #e2e8f0",borderRadius:8,padding:12 }}>
                              <div style={{ fontSize:11,fontWeight:600,color:"#64748b",marginBottom:8,textTransform:"uppercase",letterSpacing:"0.05em" }}>Split this transaction</div>
                              {splitDraft.map((sp,idx)=>(
                                <div key={sp.id} style={{ display:"flex",gap:6,marginBottom:6,alignItems:"center" }}>
                                  <select value={sp.category} onChange={e=>setSplitDraft(d=>d.map((x,i)=>i===idx?{...x,category:e.target.value}:x))}
                                    style={{ flex:1,padding:"6px 8px",border:"1px solid #e2e8f0",borderRadius:6,fontSize:12,background:"#fff" }}>
                                    <option value="">— category —</option>
                                    {EXPENSE_CAT_LABELS.map(c=><option key={c} value={c}>{c}</option>)}
                                  </select>
                                  <input type="number" value={sp.amount} onChange={e=>setSplitDraft(d=>d.map((x,i)=>i===idx?{...x,amount:e.target.value}:x))}
                                    style={{ width:80,padding:"6px 8px",border:"1px solid #e2e8f0",borderRadius:6,fontSize:12 }}/>
                                  {splitDraft.length>2&&(
                                    <button onClick={()=>setSplitDraft(d=>d.filter((_,i)=>i!==idx))} style={{ background:"none",border:"none",color:"#94a3b8",cursor:"pointer",fontSize:14 }}>×</button>
                                  )}
                                </div>
                              ))}
                              <button onClick={()=>setSplitDraft(d=>[...d,{id:newId(),category:"",amount:0}])}
                                style={{ background:"none",border:"none",color:"#0F6E56",fontSize:11,fontWeight:600,cursor:"pointer",padding:0,marginBottom:8 }}>
                                + Add another split
                              </button>
                              <div style={{ fontSize:11,color:Math.abs(remaining)<0.01?"#166534":"#b45309",marginBottom:8 }}>
                                {Math.abs(remaining)<0.01 ? "✓ Fully allocated" : `${fmtFull(remaining)} remaining to allocate`}
                              </div>
                              <div style={{ display:"flex",gap:8 }}>
                                <Btn size="sm" disabled={Math.abs(remaining)>=0.01||splitDraft.some(sp=>!sp.category)}
                                  onClick={()=>{
                                    const finalSplits = splitDraft.map(sp=>{
                                      const cat=getCategory(sp.category);
                                      return { id:sp.id, category:sp.category, amount:+sp.amount, taxDeductible:cat?.deductible??false, deductibleFraction:cat?.fraction??1 };
                                    });
                                    tagBank(b.id,{...b,splits:finalSplits,taxDeductible:finalSplits.some(s=>s.taxDeductible),reviewed:true});
                                    setSplittingId(null);
                                  }}>Save split</Btn>
                                <Btn size="sm" variant="ghost" onClick={()=>setSplittingId(null)}>Cancel</Btn>
                              </div>
                            </div>
                          );
                        })()}

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
                              <div style={{ display:"flex",alignItems:"center",gap:6,flexWrap:"wrap" }}>
                                <span style={{ fontSize:12,color:"#166534",fontWeight:600 }}>✓ On file</span>
                                <Btn size="sm" variant="secondary" onClick={()=>setViewingReceipt(b.receipt)}>📎 View</Btn>
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
                        <Btn size="sm" onClick={()=>{ setBanks(bk=>bk.map(x=>x.id===b.id?{...x,reviewed:!x.reviewed}:x)); if(!b.reviewed) setExpandedId(null); }}>
                          {b.reviewed ? "↩ Unmark reviewed" : "✓ Mark reviewed"}
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
        const deductible = filteredBanks.filter(b=>deductibleAmount(b)>0 && (typeFilter!=="missingReceipts"||!b.receipt));
        const total      = deductible.reduce((s,b)=>s+deductibleAmount(b),0);
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
                          <div style={{ fontSize:13,fontWeight:500,color:"#1e293b" }}>{cleanMerchantName(b.description)}</div>
                          <div style={{ fontSize:11,color:"#94a3b8",marginTop:2,display:"flex",gap:8,flexWrap:"wrap" }}>
                            <span style={{ whiteSpace:"nowrap" }}>{b.date}</span>
                            <Badge label={b.splits?.length ? `Split (${b.splits.length})` : (b.category||"Business")} color="teal"/>
                            {(b.deductibleFraction??1)<1&&!b.splits?.length&&<Badge label="50% rule" color="amber"/>}
                            {b.manual&&<Badge label="Manual" color="gray"/>}
                            {b.notes&&<span style={{ fontStyle:"italic" }}>"{b.notes}"</span>}
                          </div>
                        </div>
                        <div style={{ textAlign:"right",flexShrink:0 }}>
                          <div style={{ fontSize:14,fontWeight:700,color:"#1e293b" }}>{fmt(deductibleAmount(b))}</div>
                          {deductibleAmount(b)<Math.abs(b.amount)&&<div style={{ fontSize:10,color:"#94a3b8" }}>of {fmt(Math.abs(b.amount))} total</div>}
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
                                <div style={{ display:"flex",alignItems:"center",gap:8,flexWrap:"wrap" }}>
                                  <span style={{ fontSize:13,color:"#166534",fontWeight:600 }}>✓ Receipt on file</span>
                                  <Btn size="sm" variant="secondary" onClick={()=>setViewingReceipt(b.receipt)}>📎 View</Btn>
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
          {globalPractices.map(pr=>{
            const prProd  = globalProduction.filter(r=>r.practiceId===pr.id).reduce((s,r)=>s+r.production,0);
            const prDeps  = globalBanks.filter(b=>b.type==="collection"&&b.practiceId===pr.id).reduce((s,b)=>s+b.amount,0);
            const prLab   = pr.deductsLabFees ? globalProduction.filter(r=>r.practiceId===pr.id).reduce((s,r)=>s+(r.labFees||0),0) : 0;
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
// ── Real bank connection via Plaid Link ─────────────────────────────────────
// Plaid Link is Plaid's own hosted widget: it shows a searchable list of
// thousands of real banks and credit unions, handles the login/MFA flow
// itself, and hands us back a public_token — we never see or store bank
// passwords ourselves.
const PlaidModal = ({ onConnect, onTransactionsSynced, onClose }) => {
  const [linkToken, setLinkToken] = useState(null);
  const [phase, setPhase] = useState("loading"); // loading | ready | connecting | syncing | done | error
  const [error, setError] = useState("");
  const [gotTransactions, setGotTransactions] = useState(false);

  const authedFetch = async (url, body) => {
    const { data: { session } } = await supabase.auth.getSession();
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${session?.access_token}` },
      body: JSON.stringify(body || {}),
    });
    const json = await resp.json();
    if (!resp.ok) throw new Error(json.error || "Request failed");
    return json;
  };

  useEffect(() => {
    authedFetch("/api/plaid/create-link-token")
      .then(({ link_token }) => { setLinkToken(link_token); setPhase("ready"); })
      .catch(e => { setError(e.message); setPhase("error"); });
  }, []);

  const onSuccess = async (public_token, metadata) => {
    setPhase("connecting");
    try {
      const { accounts } = await authedFetch("/api/plaid/exchange-public-token", {
        public_token,
        institution: metadata.institution,
        accounts: metadata.accounts,
      });
      onConnect(accounts);
      setPhase("syncing");

      // A brand-new bank connection often isn't immediately ready with
      // transaction history on Plaid's side — retry a few times with a
      // short pause instead of leaving the feed looking empty and making
      // the person hunt for a "Sync now" button themselves.
      let synced = await authedFetch("/api/plaid/sync-transactions");
      let attempts = 0;
      while ((!synced.added || synced.added.length === 0) && attempts < 6) {
        await new Promise(r => setTimeout(r, 3000));
        synced = await authedFetch("/api/plaid/sync-transactions");
        attempts++;
      }
      onTransactionsSynced?.(synced);
      setGotTransactions((synced.added || []).length > 0);
      setPhase("done");
    } catch (e) {
      setError(e.message);
      setPhase("error");
    }
  };

  const { open, ready } = usePlaidLink({ token: linkToken, onSuccess });

  return (
    <div className="dt-modal-overlay" style={{ position:"fixed",inset:0,background:"rgba(0,0,0,0.45)",display:"flex",alignItems:"center",justifyContent:"center",zIndex:1000 }}>
      <Card className="dt-modal-card" style={{ width:440,padding:28,overflowY:"auto",maxHeight:"90vh" }}>
        {phase==="done" ? (
          <div style={{ textAlign:"center",padding:"24px 0" }}>
            <div style={{ fontSize:36,marginBottom:12 }}>✅</div>
            <div style={{ fontSize:16,fontWeight:700,color:"#1e293b",marginBottom:6 }}>Bank connected</div>
            <div style={{ fontSize:13,color:"#64748b",marginBottom:20 }}>
              {gotTransactions
                ? "Your transactions have been imported and will keep syncing."
                : "Your bank is still preparing your transaction history — this can occasionally take a few minutes for a brand-new connection. It'll appear on its own; no need to do anything else."}
            </div>
            <Btn onClick={onClose}>Done</Btn>
          </div>
        ) : (
          <>
            <div style={{ display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:20 }}>
              <div style={{ fontSize:16,fontWeight:700,color:"#1e293b" }}>Connect your bank</div>
              <Btn variant="ghost" size="sm" onClick={onClose}>Close</Btn>
            </div>

            <div style={{ fontSize:13,color:"#64748b",marginBottom:20 }}>
              Search for and connect any bank or credit union to automatically pull in deposits and expenses — you'll log in on your bank's own secure screen inside the next step, and we never see or store your bank password.
            </div>

            {phase==="error" && (
              <div style={{ background:"#fee2e2",color:"#991b1b",borderRadius:8,padding:"10px 14px",fontSize:13,marginBottom:16 }}>{error}</div>
            )}

            <Btn size="lg" onClick={()=>open()} disabled={!ready||phase==="connecting"||phase==="syncing"} style={{ justifyContent:"center", width:"100%", opacity:(!ready||phase==="connecting"||phase==="syncing")?0.6:1 }}>
              {phase==="loading" ? "Loading…" : phase==="connecting" ? "Connecting…" : phase==="syncing" ? "Importing transactions… (can take a moment)" : "🏦 Search for your bank"}
            </Btn>

            <div style={{ fontSize:11,color:"#94a3b8",marginTop:14,textAlign:"center" }}>
              Powered by Plaid · Bank-level 256-bit encryption · Read-only access
            </div>
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

const SettingsTab = ({ agreement, setAgreement, practices, setPractices, isMobile, connectedAccounts, setConnectedAccounts, setBanks, activeSection, bankRules, addRule, updateRule, deleteRule }) => {
  const [showModal, setShowModal]       = useState(false);
  const [editPractice, setEditPractice] = useState(null);
  const [showPlaid, setShowPlaid]       = useState(false);
  const [syncing, setSyncing]           = useState(false);
  const [showRuleForm, setShowRuleForm] = useState(false);
  const [editRule, setEditRule]         = useState(null);
  const [showDeactivate, setShowDeactivate] = useState(false);
  const [deactivating, setDeactivating]     = useState(false);
  const [deactivateError, setDeactivateError] = useState("");
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

  const deactivateAccount = async () => {
    setDeactivating(true);
    setDeactivateError("");
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const resp = await fetch("/api/deactivate-account", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${session?.access_token}` },
      });
      const json = await resp.json();
      if (!resp.ok) throw new Error(json.error || "Could not deactivate your account.");
      await supabase.auth.signOut();
    } catch (e) {
      setDeactivateError(e.message);
      setDeactivating(false);
    }
  };

  const removeAccount = async (acc) => {
    if (acc.plaidItemId) {
      try {
        const { data: { session } } = await supabase.auth.getSession();
        await fetch("/api/plaid/remove-item", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${session?.access_token}` },
          body: JSON.stringify({ plaidItemId: acc.plaidItemId }),
        });
      } catch {}
      // The database cascades this delete automatically, but our local copy
      // of the transactions doesn't know that — if we don't also drop them
      // here, the next background save would just write them right back.
      setBanks(bk => bk.filter(b => b.plaidItemId !== acc.plaidItemId));
    }
    setConnectedAccounts(a=>a.filter(x=>x.id!==acc.id));
  };

  const mergeSyncedTransactions = (synced) => {
    setBanks(bk => {
      const removed = new Set(synced?.removedIds||[]);
      const kept = bk.filter(b=>!removed.has(b.plaidTransactionId));
      const byId = new Map(kept.map(b=>[b.id,b]));
      (synced?.added||[]).forEach(a=>byId.set(a.id,a));
      return Array.from(byId.values());
    });
  };

  const [syncError, setSyncError]       = useState("");
  const syncNow = async () => {
    setSyncing(true);
    setSyncError("");
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const resp = await fetch("/api/plaid/sync-transactions", {
        method:"POST",
        headers:{ "Content-Type":"application/json", Authorization:`Bearer ${session?.access_token}` },
      });
      const json = await resp.json();
      if(resp.ok) {
        mergeSyncedTransactions(json);
        setConnectedAccounts(a=>a.map(x=>({ ...x, lastSync:new Date().toISOString().slice(0,10) })));
        if (json.itemErrors?.length) {
          setSyncError(json.itemErrors.map(e=>`${e.institution}: ${e.message}`).join(" · "));
        }
      } else {
        setSyncError(json.error || "Sync failed.");
      }
    } catch {
      setSyncError("Sync failed — check your connection and try again.");
    }
    setSyncing(false);
  };

  return (
    <div style={{ display:"flex",flexDirection:"column",gap:20 }}>
      {(showModal||editPractice)&&<PracticeModal practice={editPractice} onSave={savePractice} onClose={()=>{ setShowModal(false); setEditPractice(null); }}/>}
      {showPlaid&&<PlaidModal onConnect={accs=>setConnectedAccounts(a=>[...a,...accs.filter(na=>!a.find(x=>x.id===na.id))])} onTransactionsSynced={mergeSyncedTransactions} onClose={()=>setShowPlaid(false)} />}
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
          <div style={{ display:"flex",gap:8 }}>
            {!!connectedAccounts.length && (
              <Btn variant="secondary" onClick={syncNow} disabled={syncing} style={{ opacity:syncing?0.6:1 }}>
                {syncing?"Syncing…":"🔄 Sync now"}
              </Btn>
            )}
            <Btn onClick={()=>setShowPlaid(true)}>+ Connect account</Btn>
          </div>
        </div>
        {syncError&&(
          <div style={{ background:"#fef2f2",border:"1px solid #fecaca",color:"#991b1b",borderRadius:8,padding:"8px 12px",fontSize:12,marginBottom:14 }}>
            ⚠ {syncError}
          </div>
        )}
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
              <div key={acc.id} style={{ display:"flex",flexDirection:"column",gap:10,padding:"12px 14px",border:"1px solid #e2e8f0",borderRadius:10,background:"#fafafa" }}>
                <div style={{ display:"flex",alignItems:"center",gap:10,minWidth:0 }}>
                  <div style={{ width:32,height:32,background:acc.type==="credit"?"#ede9fe":"#E1F5EE",borderRadius:8,display:"flex",alignItems:"center",justifyContent:"center",fontSize:16,flexShrink:0 }}>
                    {acc.type==="credit"?"💳":"🏦"}
                  </div>
                  <div style={{ flex:1,minWidth:0 }}>
                    <div style={{ fontWeight:600,color:"#1e293b",fontSize:13 }}>{acc.name} ···{acc.mask}</div>
                    <div style={{ fontSize:11,color:"#94a3b8",whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis" }}>{acc.institution}</div>
                  </div>
                </div>
                <div style={{ display:"flex",alignItems:"center",justifyContent:"space-between",gap:8 }}>
                  <div style={{ display:"flex",alignItems:"center",gap:6,flexWrap:"wrap" }}>
                    <Badge label={acc.label} color={acc.label==="Corp bank"?"teal":acc.label==="Corp credit card"?"purple":"gray"} />
                    <Badge label="Live" color="green" />
                  </div>
                  <button onClick={()=>removeAccount(acc)} style={{ background:"none",border:"none",color:"#dc2626",fontSize:12,fontWeight:600,cursor:"pointer",padding:"4px 2px",flexShrink:0 }}>
                    Disconnect
                  </button>
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

      {/* Danger zone */}
      <Card style={{ border:"1px solid #fecaca" }}>
        <div style={{ fontSize:15,fontWeight:700,color:"#1e293b",marginBottom:4 }}>Deactivate account</div>
        <div style={{ fontSize:13,color:"#64748b",marginBottom:16,lineHeight:1.5 }}>
          Not using DentaTrack right now? You can deactivate instead of walking away — your practices, production, and expense history stay safely on file, and you can come back anytime.
        </div>
        <Btn variant="danger" onClick={()=>{ setShowDeactivate(true); setDeactivateError(""); }}>Deactivate my account</Btn>
      </Card>

      {showDeactivate&&(
        <div className="dt-modal-overlay" style={{ position:"fixed",inset:0,background:"rgba(0,0,0,0.5)",display:"flex",alignItems:"center",justifyContent:"center",zIndex:1002 }}>
          <Card style={{ width:440,padding:28 }}>
            <div style={{ fontSize:17,fontWeight:700,color:"#1e293b",marginBottom:10 }}>Deactivate your account?</div>
            <div style={{ fontSize:13,color:"#475569",lineHeight:1.6,marginBottom:14 }}>
              Here's exactly what happens, so there's no surprise:
            </div>
            <div style={{ display:"flex",flexDirection:"column",gap:10,marginBottom:16 }}>
              <div style={{ display:"flex",gap:10,fontSize:13,color:"#166534" }}>
                <span>🔒</span>
                <span>Every connected bank account is disconnected immediately, and the transaction data pulled from them is deleted — nothing sensitive is left sitting around.</span>
              </div>
              <div style={{ display:"flex",gap:10,fontSize:13,color:"#166534" }}>
                <span>✓</span>
                <span>Everything you entered yourself — practices, production, manual expenses, your profile — stays exactly as it is.</span>
              </div>
              <div style={{ display:"flex",gap:10,fontSize:13,color:"#166534" }}>
                <span>↺</span>
                <span>You can reactivate anytime just by signing back in — you'll only need to reconnect your bank accounts if you use them again.</span>
              </div>
            </div>
            {deactivateError&&(
              <div style={{ background:"#fee2e2",color:"#991b1b",borderRadius:8,padding:"10px 14px",fontSize:13,marginBottom:14 }}>{deactivateError}</div>
            )}
            <div style={{ display:"flex",gap:10,justifyContent:"flex-end" }}>
              <Btn variant="secondary" onClick={()=>setShowDeactivate(false)} disabled={deactivating}>Cancel</Btn>
              <Btn variant="danger" onClick={deactivateAccount} disabled={deactivating} style={{ opacity:deactivating?0.7:1 }}>
                {deactivating?"Deactivating…":"Yes, deactivate my account"}
              </Btn>
            </div>
          </Card>
        </div>
      )}
    </div>
  );
};

// ── Guided product tour ──────────────────────────────────────────────────────
// Shown once, automatically, right after a brand-new account finishes
// onboarding. It actually switches the real tabs behind it as you go, rather
// than being a static slideshow, so people see the real thing, not a mockup.
const TOUR_STEPS = [
  { tab:"home", title:"Welcome to DentaTrack 👋", body:"Quick 60-second look around before you dive in — skip anytime, no pressure." },
  { tab:"home", title:"Home", body:"Your financial snapshot: expected pay, expenses, and estimated net take-home for the month. \"Email my P&L\" sends a PDF summary whenever you need one." },
  { tab:"production", title:"Production", body:"Log each day's production here — this is what your pay percentage gets calculated from. Type it in, or scan a day sheet to autofill." },
  { tab:"transactions", title:"Transactions", body:"Your bank feed lives here. Tap any transaction to tag it as a deposit, expense, or transfer — split it across categories, attach a receipt, or create a rule so future ones tag themselves." },
  { tab:"settings", section:"practices", title:"Settings — Practices", body:"Add every office you work at, each with its own pay percentage and lab-fee rules — this is what your expected pay is built on." },
  { tab:"settings", section:"accounts", title:"Settings — Connected accounts", body:"Connect your real bank here so deposits and expenses import automatically instead of typing everything by hand." },
  { tab:"settings", section:"corp", title:"You're all set", body:"That's the tour! Everything here can be revisited anytime — jump back into Settings whenever you need to adjust something." },
];

const Tour = ({ isMobile, setTab, setSettingsSection, onFinish }) => {
  const [step, setStep] = useState(0);
  const s = TOUR_STEPS[step];
  const last = step === TOUR_STEPS.length - 1;

  useEffect(() => {
    setTab(s.tab);
    setSettingsSection(s.section || null);
  }, [step]);

  return (
    <div style={{ position:"fixed", inset:0, background:"rgba(15,23,42,0.45)", zIndex:1100, transition:"background 0.2s" }}>
      <div style={{
        position:"fixed",
        ...(isMobile ? { left:12, right:12, bottom:12 } : { right:24, bottom:24, width:340 }),
        background:"#fff", borderRadius:14, boxShadow:"0 10px 40px rgba(0,0,0,0.28)", border:"1px solid #e2e8f0",
        padding:20,
      }}>
        <div style={{ display:"flex", gap:5, marginBottom:14 }}>
          {TOUR_STEPS.map((_,i)=>(
            <div key={i} style={{ flex:1, height:3, borderRadius:99, background:i<=step?"#0F6E56":"#e2e8f0" }} />
          ))}
        </div>
        <div style={{ fontSize:15, fontWeight:700, color:"#1e293b", marginBottom:6 }}>{s.title}</div>
        <div style={{ fontSize:13, color:"#64748b", lineHeight:1.5, marginBottom:18 }}>{s.body}</div>
        <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center" }}>
          <button onClick={onFinish} style={{ background:"none", border:"none", color:"#94a3b8", fontSize:12, cursor:"pointer", padding:0 }}>
            Skip tour
          </button>
          <div style={{ display:"flex", gap:8 }}>
            {step>0 && <Btn size="sm" variant="secondary" onClick={()=>setStep(st=>st-1)}>Back</Btn>}
            <Btn size="sm" onClick={()=> last ? onFinish() : setStep(st=>st+1)}>{last ? "Done" : "Next →"}</Btn>
          </div>
        </div>
      </div>
    </div>
  );
};


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

const GRADUATING_YEARS = Array.from({ length:8 }, (_,i)=>(new Date().getFullYear()+7-i).toString())
  .concat(Array.from({ length:40 }, (_,i)=>(new Date().getFullYear()-i).toString()).slice(1));

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

const Onboarding = ({ onComplete, onTransactionsSynced }) => {
  const [step, setStep] = useState(1);
  const TOTAL = 4;

  const [profile, setProfile] = useState({ name:"", email:"", province:"ON", licenseNumber:"", school:"", graduatingYear:"", isCorp:false });
  const [practices, setPracticesList] = useState([]); // practices already added
  const [draft, setDraft] = useState({ name:"", pct:35, basis:"collections", deductsLabFees:false, guarantee:0, color:PRACTICE_COLORS[0] });

  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => {
      if (data?.user?.email) setProfile(p => ({ ...p, email: data.user.email }));
    });
  }, []);

  const selectedProvince = PROVINCES_FULL.find(p=>p.code===profile.province);
  const canStep2 = profile.name.trim()&&profile.email.trim()&&profile.province;
  const draftValid = draft.name.trim();
  const canStep3 = practices.length>0 || draftValid;

  const addDraftPractice = () => {
    if (!draftValid) return;
    setPracticesList(list=>[...list, { ...draft }]);
    setDraft({ name:"", pct:35, basis:"collections", deductsLabFees:false, guarantee:0, color:PRACTICE_COLORS[(practices.length+1)%PRACTICE_COLORS.length] });
  };

  const finish = () => {
    const finalProfile = {
      ...profile,
      school: (profile.school==="Other / International" && profile.schoolOther?.trim()) ? profile.schoolOther.trim() : profile.school,
    };
    // Include whatever's currently in the draft form too, so someone with
    // just one practice doesn't have to remember to hit "Add" before continuing.
    const finalPractices = draftValid ? [...practices, { ...draft }] : practices;
    // Bank connection no longer happens during onboarding — it's prompted
    // later, on the Home tab, once someone's actually seen the app do
    // something useful first.
    onComplete({ profile: finalProfile, practices: finalPractices.map(p=>({ ...p, address:"", city:"", postalCode:"" })), connectedAccts: [] });
  };


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
        <div style={{ borderTop:"1px solid #f1f5f9",paddingTop:16 }}>
          <div style={{ fontSize:12,color:"#94a3b8",fontWeight:500,textTransform:"uppercase",letterSpacing:"0.05em",marginBottom:14 }}>Optional</div>
          <div style={{ display:"flex",flexDirection:"column",gap:14 }}>
            <div>
              <Input
                label="College / Board license #"
                value={profile.licenseNumber}
                onChange={e=>setProfile(p=>({...p,licenseNumber:e.target.value}))}
                placeholder={selectedProvince ? `e.g. ${selectedProvince.example}` : "Your license or registration number"}
              />
              <div style={{ fontSize:11,color:"#94a3b8",marginTop:4 }}>
                Find this on your registration certificate or your provincial college / state dental board member portal. You can add this later too.
              </div>
            </div>
            <Sel label="School / University" value={profile.school} onChange={e=>setProfile(p=>({...p,school:e.target.value}))}>
              <option value="">Select school…</option>
              {DENTAL_SCHOOLS.map(s=><option key={s} value={s}>{s}</option>)}
            </Sel>
            {profile.school==="Other / International"&&(
              <Input label="Your school's name" value={profile.schoolOther||""} onChange={e=>setProfile(p=>({...p,schoolOther:e.target.value}))} placeholder="Type your school's name" />
            )}
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

  // Step 3 — Practices (supports adding more than one)
  if(step===3) return (
    <OnboardingShell step={step} total={TOTAL}>
      <div style={{ fontSize:22,fontWeight:800,color:"#1e293b",marginBottom:4 }}>Your practice{practices.length>1?"s":""}</div>
      <div style={{ fontSize:13,color:"#94a3b8",marginBottom:20 }}>Add every office you work at — you can always add more later in Settings too.</div>

      {practices.length>0&&(
        <div style={{ display:"flex",flexDirection:"column",gap:8,marginBottom:20 }}>
          {practices.map((p,i)=>(
            <div key={i} style={{ display:"flex",alignItems:"center",gap:10,padding:"10px 14px",border:"1px solid #e2e8f0",borderRadius:10,background:"#f8fafc" }}>
              <div style={{ width:8,height:8,borderRadius:"50%",background:p.color,flexShrink:0 }} />
              <div style={{ flex:1,minWidth:0 }}>
                <div style={{ fontSize:13,fontWeight:600,color:"#1e293b" }}>{p.name}</div>
                <div style={{ fontSize:11,color:"#94a3b8" }}>{p.pct}% · {p.basis==="collections"?"Collections":p.basis==="production"?"Gross production":"Adjusted production"}</div>
              </div>
              <button onClick={()=>setPracticesList(list=>list.filter((_,idx)=>idx!==i))} style={{ background:"none",border:"none",color:"#94a3b8",fontSize:13,cursor:"pointer",padding:4 }}>Remove</button>
            </div>
          ))}
        </div>
      )}

      <div style={{ display:"flex",flexDirection:"column",gap:16 }}>
        {practices.length>0&&<div style={{ fontSize:12,fontWeight:600,color:"#64748b" }}>{draftValid||practices.length===0 ? "Add another practice" : "Add another practice (optional)"}</div>}
        <Input label="Practice name *" value={draft.name} onChange={e=>setDraft(p=>({...p,name:e.target.value}))} placeholder="e.g. Sunshine Dental" />
        <div>
          <div style={{ display:"flex",justifyContent:"space-between",alignItems:"baseline",marginBottom:6 }}>
            <label style={{ fontSize:12,fontWeight:500,color:"#475569" }}>Pay percentage *</label>
            <span style={{ fontSize:20,fontWeight:800,color:"#1e293b" }}>{draft.pct}%</span>
          </div>
          <input type="range" min={20} max={50} value={draft.pct} onChange={e=>setDraft(p=>({...p,pct:+e.target.value}))} style={{ width:"100%" }} />
          <div style={{ display:"flex",justifyContent:"space-between",fontSize:11,color:"#94a3b8",marginTop:2 }}>
            <span>20%</span><span>50%</span>
          </div>
        </div>
        <Sel label="Pay basis *" value={draft.basis} onChange={e=>setDraft(p=>({...p,basis:e.target.value}))}>
          <option value="collections">Collections — what the practice actually received</option>
          <option value="production">Gross production — your full fee schedule</option>
          <option value="adjusted">Adjusted production — after write-offs</option>
        </Sel>
        <label style={{ display:"flex",alignItems:"flex-start",gap:12,cursor:"pointer",background:"#f8fafc",padding:"12px 14px",borderRadius:10,border:"1px solid #e2e8f0" }}>
          <input type="checkbox" checked={draft.deductsLabFees} onChange={e=>setDraft(p=>({...p,deductsLabFees:e.target.checked}))} style={{ width:20,height:20,marginTop:2,flexShrink:0 }} />
          <div>
            <div style={{ fontSize:14,fontWeight:600,color:"#1e293b" }}>Lab fees deducted before my pay %</div>
            <div style={{ fontSize:12,color:"#94a3b8",marginTop:2 }}>e.g. contract says: 40% of (collections − lab fees). Check your agreement.</div>
          </div>
        </label>

        {draftValid&&(
          <button onClick={addDraftPractice} style={{ display:"flex",alignItems:"center",justifyContent:"center",gap:6,background:"none",border:"1px dashed #0F6E56",borderRadius:10,padding:"10px 0",fontSize:13,fontWeight:600,color:"#0F6E56",cursor:"pointer" }}>
            + Add this practice, then add another
          </button>
        )}

        <Btn size="lg" onClick={()=>{ if(draftValid) addDraftPractice(); setStep(4); }} disabled={!canStep3}
          style={{ width:"100%",justifyContent:"center",marginTop:4,opacity:canStep3?1:0.4 }}>
          Continue →
        </Btn>
        <button onClick={()=>setStep(2)} style={{ background:"none",border:"none",color:"#94a3b8",fontSize:13,cursor:"pointer",textAlign:"center" }}>← Back</button>
      </div>
    </OnboardingShell>
  );

  // Step 4 — Ready
  if(step===4) return (
    <OnboardingShell step={step} total={TOTAL}>
      <div style={{ textAlign:"center" }}>
        <div style={{ fontSize:48,marginBottom:16 }}>🎉</div>
        <div style={{ fontSize:24,fontWeight:800,color:"#1e293b",marginBottom:8 }}>
          You're all set{profile.name?`, ${profile.name.replace("Dr.","").trim().split(" ")[0]}`:""}!
        </div>
        <div style={{ fontSize:14,color:"#64748b",marginBottom:8,lineHeight:1.6 }}>
          {(() => {
            const all = draftValid ? [...practices, draft] : practices;
            if (all.length === 1) {
              const p = all[0];
              return <><strong>{p.name}</strong> is ready — {p.pct}% of {p.basis}{p.deductsLabFees?" · lab fees deducted":""}</>;
            }
            return <><strong>{all.length} practices</strong> are set up and ready to go</>;
          })()}
        </div>
        <div style={{ fontSize:12,color:"#94a3b8",marginBottom:24 }}>You can connect your bank whenever you're ready — we'll remind you once you're in.</div>
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
  const isMobile = useIsMobile();
  const isStandalone = useIsStandalone();
  const [updateAvailable, setUpdateAvailable] = useState(false);
  useEffect(() => {
    const flag = () => setUpdateAvailable(true);
    window.addEventListener("dt-update-available", flag);
    return () => window.removeEventListener("dt-update-available", flag);
  }, []);

  const [production, setProduction] = useState([]);
  const [expenses, setExpenses]     = useState([]);
  const [banks, setBanks]           = useState([]);
  const [bankRules, setBankRules]   = useState([]);
  const [practices, setPractices]   = useState([]);
  const [agreement, setAgreement]   = useState({ isCorp:false,salary:0,dividends:0,name:"",corpName:"",tourCompleted:true });
  const [connectedAccounts, setConnectedAccounts] = useState([]);
  // Global Day/Week/Month/Year + practice filter, shared by Home, Production,
  // and Transactions.
  const [filterPeriod, setFilterPeriod] = useState("month");
  const [filterPracticeId, setFilterPracticeId] = useState(null);
  // Bumped on every connectedAccounts change so an in-flight save from an
  // older, stale snapshot can tell it's been superseded and skip its own
  // delete step — otherwise a slow older save finishing after a newer one
  // can wipe out a bank connection the newer save just wrote.
  const connectedAccountsSaveSeq = useRef(0);
  const [menuOpen, setMenuOpen]     = useState(false);
  // Lifted out of TransactionsTab so Home's stat cards can deep-link into a
  // specific filtered view instead of just switching to a blank tab.
  const [txSub, setTxSub] = useState("all");
  const [txTypeFilter, setTxTypeFilter] = useState(null);
  const goToTransactions = (subView, filter=null) => { setTxSub(subView); setTxTypeFilter(filter); setTab("transactions"); };
  const [showFeedback, setShowFeedback] = useState(false);
  const [settingsSection, setSettingsSection] = useState(null);
  const [pullDist, setPullDist]     = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshDone, setRefreshDone] = useState(false);
  const touchStartY   = useRef(0);
  const pullActive    = useRef(false);
  const pullDistRef   = useRef(0);
  const refreshingRef = useRef(false);

  const refreshAll = async () => {
    if (!userId) return;
    const [profile, prac, prod, exp, bnk, rules, accts] = await Promise.all([
      loadProfile(userId), loadPractices(userId), loadProduction(userId), loadExpenses(userId),
      loadBanks(userId), loadBankRules(userId), loadConnectedAccounts(userId),
    ]);
    if (profile) setAgreement(profile);
    setPractices(prac);
    setProduction(prod);
    setExpenses(exp);
    setBanks(bnk);
    setBankRules(rules);
    setConnectedAccounts(accts);
  };

  // Pull-to-refresh — only for the installed, standalone app, which has no
  // browser chrome of its own to pull from. Someone just visiting the site
  // in a normal Safari/Chrome tab keeps their browser's own native
  // pull-to-refresh completely untouched — this never engages for them.
  useEffect(() => {
    if (!isStandalone) return;

    // Only suppress the native bounce/refresh while the app is running
    // standalone — restored on cleanup so it never affects a regular tab.
    const prevOverscroll = document.documentElement.style.overscrollBehaviorY;
    document.documentElement.style.overscrollBehaviorY = 'contain';

    const getScrollTop = () => window.scrollY || document.documentElement.scrollTop || document.body.scrollTop || 0;

    const onTouchStart = (e) => {
      if (refreshingRef.current || getScrollTop() > 0) return;
      touchStartY.current = e.touches[0].clientY;
      pullActive.current = true;
    };

    const onTouchMove = (e) => {
      if (!pullActive.current || refreshingRef.current) return;
      const delta = e.touches[0].clientY - touchStartY.current;
      if (delta > 0 && getScrollTop() === 0) {
        e.preventDefault(); // take over the gesture from native bounce/scroll
        const dist = Math.min(delta * 0.5, 80);
        pullDistRef.current = dist;
        setPullDist(dist);
      } else {
        pullActive.current = false;
        pullDistRef.current = 0;
        setPullDist(0);
      }
    };

    const onTouchEnd = async () => {
      if (!pullActive.current) return;
      pullActive.current = false;
      if (pullDistRef.current > 45) {
        refreshingRef.current = true;
        setRefreshing(true);
        setPullDist(56);
        // Enforce a minimum visible duration — a real refresh can finish in
        // under 200ms, which reads as "did anything even happen?" without this.
        await Promise.all([refreshAll(), new Promise(r => setTimeout(r, 1000))]);
        refreshingRef.current = false;
        setRefreshing(false);
        setRefreshDone(true);
        setTimeout(() => setRefreshDone(false), 900);
      }
      pullDistRef.current = 0;
      setPullDist(0);
    };

    document.addEventListener('touchstart', onTouchStart, { passive: true });
    document.addEventListener('touchmove', onTouchMove, { passive: false });
    document.addEventListener('touchend', onTouchEnd, { passive: true });
    return () => {
      document.documentElement.style.overscrollBehaviorY = prevOverscroll;
      document.removeEventListener('touchstart', onTouchStart);
      document.removeEventListener('touchmove', onTouchMove);
      document.removeEventListener('touchend', onTouchEnd);
    };
  }, [isStandalone, userId]);

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
  useEffect(() => {
    if (!dataLoaded || !userId) return;
    const seq = ++connectedAccountsSaveSeq.current;
    syncConnectedAccounts(userId, connectedAccounts, () => connectedAccountsSaveSeq.current === seq);
  }, [connectedAccounts, dataLoaded, userId]);
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

  const mergeSyncedTransactions = (synced) => {
    setBanks(bk => {
      const removed = new Set(synced?.removedIds||[]);
      const kept = bk.filter(b=>!removed.has(b.plaidTransactionId));
      const byId = new Map(kept.map(b=>[b.id,b]));
      (synced?.added||[]).forEach(a=>byId.set(a.id,a));
      return Array.from(byId.values());
    });
  };

  const handleOnboardingComplete = ({ profile, practices: newPractices, connectedAccts }) => {
    setAgreement(a => ({
      ...a,
      name: profile.name,
      isCorp: profile.isCorp,
      province: profile.province,
      licenseNumber: profile.licenseNumber,
      school: profile.school,
      graduatingYear: profile.graduatingYear,
    }));
    setPractices(p => [...p, ...(newPractices||[]).map(pr => ({ ...pr, id: newId() }))]);
    if (connectedAccts?.length) setConnectedAccounts(a => [...a, ...connectedAccts]);
  };

  if (!dataLoaded) {
    return (
      <div style={{ minHeight:"100vh",display:"flex",alignItems:"center",justifyContent:"center",fontFamily:"system-ui,-apple-system,sans-serif",color:"#94a3b8" }}>
        Loading your data…
      </div>
    );
  }

  if (practices.length === 0) {
    return <Onboarding onComplete={handleOnboardingComplete} onTransactionsSynced={mergeSyncedTransactions} />;
  }

  const smartBanks  = flagTransfers(applyRules(banks, bankRules));
  const matches     = buildMatches(expenses, smartBanks);
  const duplicateIds = detectDuplicates(smartBanks);

  // Global Day/Week/Month/Year + practice filter — feeds Home, Production,
  // and Transactions. `filteredX` is scoped to the current single period
  // (e.g. this calendar month) and the selected practice, if any — used for
  // stat cards and the Production log. `practiceFilteredX` only narrows by
  // practice, keeping full history — used for the Home chart's trailing
  // buckets, which need real history regardless of which period is selected.
  const currentPeriodRange = periodRange(filterPeriod);
  const matchesPractice = (practiceId) => !filterPracticeId || practiceId === filterPracticeId;
  const practiceFilteredProduction = production.filter(r => matchesPractice(r.practiceId));
  const practiceFilteredBanks = smartBanks.filter(b => matchesPractice(b.practiceId));
  const filteredProduction = practiceFilteredProduction.filter(r => dateInRange(r.date, currentPeriodRange));
  const filteredBanks = practiceFilteredBanks.filter(b => dateInRange(b.date, currentPeriodRange));

  // Collections summary per practice — respects the global filter above, and
  // narrows to just the selected practice's card when one is chosen.
  const visiblePractices = filterPracticeId ? practices.filter(p=>p.id===filterPracticeId) : practices;
  const collectionsSummary = visiblePractices.map(pr => {
    const prDeposits = filteredBanks.filter(b=>b.type==="collection"&&b.practiceId===pr.id).reduce((s,b)=>s+b.amount,0);
    const prProd     = filteredProduction.filter(r=>r.practiceId===pr.id).reduce((s,r)=>s+r.production,0);
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
    <div className="dt-app" style={{ minHeight:"100vh",background:"#f8fafc",fontFamily:"system-ui,-apple-system,sans-serif",paddingBottom:isMobile?90:0 }} onClick={()=>menuOpen&&setMenuOpen(false)}>
      <GlobalStyles />

      {/* New deploy ready — shown until tapped, never applied silently. */}
      {updateAvailable&&(
        <div style={{ position:"fixed",top:0,left:0,right:0,zIndex:400,background:"#0F6E56",color:"#fff",padding:"10px 16px",display:"flex",alignItems:"center",justifyContent:"center",gap:12,flexWrap:"wrap",fontSize:13,fontWeight:600 }}>
          <span>🔄 A new version of DentaTrack is available</span>
          <button onClick={()=>window.__dtApplyUpdate?.()} style={{ background:"#fff",color:"#0F6E56",border:"none",borderRadius:8,padding:"5px 14px",fontSize:12,fontWeight:700,cursor:"pointer" }}>
            Update now
          </button>
        </div>
      )}

      {/* Pull-to-refresh indicator */}
      {isStandalone&&pullDist>0&&!refreshing&&!refreshDone&&(
        <div style={{ position:"fixed",top:0,left:0,right:0,display:"flex",justifyContent:"center",alignItems:"flex-end",height:pullDist,overflow:"hidden",zIndex:200,pointerEvents:"none" }}>
          <div style={{ paddingBottom:8 }}>
            <div style={{
              width:22,height:22,borderRadius:"50%",border:"2.5px solid #0F6E56",borderTopColor:"transparent",
              transform:`rotate(${pullDist*4}deg)`, transition:"transform 0.05s linear",
            }}/>
          </div>
        </div>
      )}

      {(refreshing||refreshDone)&&(
        <div style={{ position:"fixed",top:20,left:0,right:0,display:"flex",justifyContent:"center",zIndex:200,pointerEvents:"none" }}>
          <div style={{ background:"#1e293b",color:"#fff",borderRadius:99,padding:"10px 20px",display:"flex",alignItems:"center",gap:10,boxShadow:"0 8px 24px rgba(0,0,0,0.25)" }}>
            {refreshDone ? (
              <>
                <span style={{ fontSize:15 }}>✓</span>
                <span style={{ fontSize:13,fontWeight:600 }}>Updated</span>
              </>
            ) : (
              <>
                <div style={{ width:15,height:15,borderRadius:"50%",border:"2px solid rgba(255,255,255,0.3)",borderTopColor:"#fff",animation:"dt-spin 0.7s linear infinite" }}/>
                <span style={{ fontSize:13,fontWeight:600 }}>Refreshing…</span>
              </>
            )}
          </div>
        </div>
      )}

      {/* Header */}
      <div style={{ background:"#fff",borderBottom:"1px solid #e2e8f0",padding:isMobile?"0 16px":"0 32px",position:"sticky",top:0,zIndex:100 }}>
        <div style={{ maxWidth:1100,margin:"0 auto",display:"flex",alignItems:"center",gap:24 }}>
          {/* Logo — always returns to Home */}
          <div onClick={()=>setTab("home")} style={{ padding:"14px 0",display:"flex",alignItems:"center",gap:10,flex:1,cursor:"pointer" }}>
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

                <div style={{ borderTop:"1px solid #f1f5f9",padding:"8px 16px" }}>
                  <button onClick={()=>{ setShowFeedback(true); setMenuOpen(false); }} style={{ width:"100%",padding:"9px 0",border:"none",background:"transparent",display:"flex",alignItems:"center",gap:10,cursor:"pointer",textAlign:"left",fontSize:13,color:"#1e293b",fontWeight:500 }}
                    onMouseEnter={e=>e.currentTarget.style.background="#f8fafc"}
                    onMouseLeave={e=>e.currentTarget.style.background="transparent"}>
                    <span style={{ fontSize:16 }}>💬</span>Send feedback
                  </button>
                </div>

                <div style={{ borderTop:"1px solid #f1f5f9",padding:"8px 16px 12px" }}>
                  <button onClick={() => supabase.auth.signOut()} style={{ width:"100%",padding:"9px 0",border:"none",background:"transparent",color:"#000000",fontSize:13,cursor:"pointer",textAlign:"left" }}>Sign out</button>
                </div>
              </div>
            )}
          </div>
        </div>
        {showFeedback&&<FeedbackModal onClose={()=>setShowFeedback(false)} currentTab={tab}/>}
      </div>

      {/* Content */}
      <div style={{ maxWidth:1100,margin:"0 auto",padding:isMobile?"20px 16px":"28px 32px" }}>
        <div style={{ marginBottom:isMobile?18:24 }}>
          <div style={{ fontSize:isMobile?19:22,fontWeight:800,color:"#1e293b",letterSpacing:"-0.02em" }}>
            {tab==="home"?"Home":tab==="production"?"Production":tab==="transactions"?"Transactions":"Settings"}
          </div>
          <div style={{ fontSize:13,color:"#94a3b8",marginTop:2 }}>
            {tab==="home"&&"Your financial snapshot"}
            {tab==="production"&&"Log production and review your daily entries"}
            {tab==="transactions"&&"Expenses, bank feed, and reconciliation"}
            {tab==="settings"&&"Profile, practices, and corp settings"}
          </div>
        </div>
        {(tab==="home"||tab==="production"||tab==="transactions")&&(
          <FilterBar period={filterPeriod} setPeriod={setFilterPeriod} practiceId={filterPracticeId} setPracticeId={setFilterPracticeId} practices={practices}/>
        )}
        {tab==="home"         &&<HomeTab         production={filteredProduction} expenses={expenses} banks={filteredBanks} chartProduction={practiceFilteredProduction} chartBanks={practiceFilteredBanks} filterPeriod={filterPeriod} agreement={agreement} matches={matches} practices={practices} isMobile={isMobile} collectionsSummary={collectionsSummary} connectedAccounts={connectedAccounts} setConnectedAccounts={setConnectedAccounts} onTransactionsSynced={mergeSyncedTransactions} setTab={setTab} goToTransactions={goToTransactions}/>}
        {tab==="production"   &&<ProductionTab   production={filteredProduction} setProduction={setProduction} practices={practices} filterPeriod={filterPeriod}/>}
        {tab==="transactions" &&<TransactionsTab expenses={expenses} setExpenses={setExpenses} banks={smartBanks} setBanks={setBanks} tagBank={tagBank} agreement={agreement} matches={matches} practices={practices} production={production} isMobile={isMobile} bankRules={bankRules} addRule={addRule} duplicateIds={duplicateIds} connectedAccounts={connectedAccounts} sub={txSub} setSub={setTxSub} typeFilter={txTypeFilter} setTypeFilter={setTxTypeFilter} globalPeriod={filterPeriod} globalPracticeId={filterPracticeId}/>}
        {tab==="settings"     &&<SettingsTab     agreement={agreement} setAgreement={setAgreement} practices={practices} setPractices={setPractices} isMobile={isMobile} connectedAccounts={connectedAccounts} setConnectedAccounts={setConnectedAccounts} setBanks={setBanks} activeSection={settingsSection} bankRules={bankRules} addRule={addRule} updateRule={updateRule} deleteRule={deleteRule}/>}
      </div>

      {/* Mobile bottom tab bar — 2 active tabs + future stubs */}
      {isMobile&&(
        <nav style={{ position:"fixed",left:0,right:0,bottom:0,background:"#fff",borderTop:"1px solid #e2e8f0",boxShadow:"0 -2px 12px rgba(15,23,42,0.05)",display:"flex",zIndex:100,paddingBottom:"calc(14px + env(safe-area-inset-bottom))" }}>
          {TABS.filter(t=>t.active).map(t=>(
            <button key={t.key} onClick={()=>setTab(t.key)} style={{ flex:1,border:"none",background:"transparent",cursor:"pointer",padding:"10px 0 0",display:"flex",flexDirection:"column",alignItems:"center",gap:3,color:tab===t.key?"#0F6E56":"#94a3b8" }}>
              <span style={{ fontSize:19 }}>{t.icon}</span>
              <span style={{ fontSize:11,fontWeight:600 }}>{t.label}</span>
            </button>
          ))}
          {/* Future tab stubs — greyed out, non-tappable */}
          {FUTURE_TABS.map(ft=>(
            <button key={ft.key} disabled style={{ flex:1,border:"none",background:"transparent",cursor:"default",padding:"10px 0 0",display:"flex",flexDirection:"column",alignItems:"center",gap:3,color:"#d1d5db",opacity:0.5 }}>
              <span style={{ fontSize:19 }}>{ft.icon}</span>
              <span style={{ fontSize:10,fontWeight:600 }}>{ft.label}</span>
            </button>
          ))}
        </nav>
      )}

      {!agreement.tourCompleted && (
        <Tour
          isMobile={isMobile}
          setTab={setTab}
          setSettingsSection={setSettingsSection}
          onFinish={()=>setAgreement(a=>({...a, tourCompleted:true}))}
        />
      )}
    </div>
  );
}
