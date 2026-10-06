import { useState, useEffect, useMemo, useRef } from "react";
import { ChevronLeft, ChevronRight, X, Download, Upload } from "lucide-react";

const WEEKDAYS = ["日", "一", "二", "三", "四", "五", "六"];
const WORK_START = "08:00";
const WORK_END = "17:00";
const LUNCH_START = "12:00";
const LUNCH_END = "13:00";
const STANDARD_DAY_HOURS = 8;

function pad2(n) {
  return String(n).padStart(2, "0");
}

function monthKey(year, monthIndex0) {
  return `attendance-calendar:${year}-${pad2(monthIndex0 + 1)}`;
}

function toMinutes(t) {
  const [h, m] = t.split(":").map(Number);
  return h * 60 + m;
}

function overlapMin(aStart, aEnd, bStart, bEnd) {
  return Math.max(0, Math.min(aEnd, bEnd) - Math.max(aStart, bStart));
}

// 工作日計算：08:00-17:00 為標準班，12:00-13:00 午休不計工時，
// 正常工時滿 8 小時算 1 天；17:00 以後的工時一律算加班。
function calcWork(start, end) {
  const s = toMinutes(start);
  const e = toMinutes(end);
  if (e <= s) return { valid: false, regularHours: 0, overtimeHours: 0, dayFraction: 0 };

  const workEnd = toMinutes(WORK_END);
  const lunchStart = toMinutes(LUNCH_START);
  const lunchEnd = toMinutes(LUNCH_END);

  const regEnd = Math.min(e, workEnd);
  let regularMinutes = Math.max(0, regEnd - s);
  regularMinutes -= overlapMin(s, regEnd, lunchStart, lunchEnd);
  regularMinutes = Math.max(0, regularMinutes);

  const overtimeMinutes = Math.max(0, e - workEnd);

  const regularHours = regularMinutes / 60;
  const overtimeHours = overtimeMinutes / 60;
  const dayFraction = regularHours / STANDARD_DAY_HOURS;

  return { valid: true, regularHours, overtimeHours, dayFraction };
}

// 排休計算：排休時段與「標準工時區間（08:00-12:00、13:00-17:00）」的重疊
// 部分算排休時數，其餘標準工時區間內未重疊的時段視為當日出工。
// 預設整段 08:00-17:00 都算排休 = 整日排休。
function calcOff(start, end) {
  const s = toMinutes(start);
  const e = toMinutes(end);
  if (e <= s) return { valid: false, offHours: 0, offFraction: 0, workHours: 0, dayFraction: 0 };

  const workStart = toMinutes(WORK_START);
  const workEnd = toMinutes(WORK_END);
  const lunchStart = toMinutes(LUNCH_START);
  const lunchEnd = toMinutes(LUNCH_END);

  const amOverlap = overlapMin(s, e, workStart, lunchStart);
  const pmOverlap = overlapMin(s, e, lunchEnd, workEnd);
  const offHours = (amOverlap + pmOverlap) / 60;
  const offFraction = offHours / STANDARD_DAY_HOURS;
  const workHours = Math.max(0, STANDARD_DAY_HOURS - offHours);
  const dayFraction = workHours / STANDARD_DAY_HOURS;

  return { valid: true, offHours, offFraction, workHours, dayFraction };
}

function fmt(n, decimals = 2) {
  const factor = 10 ** decimals;
  const r = Math.round((n + Number.EPSILON) * factor) / factor;
  return String(r);
}

export default function AttendanceCalendar() {
  const today = useMemo(() => new Date(), []);
  const [year, setYear] = useState(today.getFullYear());
  const [monthIndex, setMonthIndex] = useState(today.getMonth());
  const [statusMap, setStatusMap] = useState({});
  const [loading, setLoading] = useState(true);
  const [loaded, setLoaded] = useState(false); // 用 state（不是 ref）追蹤「這個月的資料是否已讀取完成」
  const [activeDay, setActiveDay] = useState(null);
  const [storageError, setStorageError] = useState(false);

  const [draftStatus, setDraftStatus] = useState("none"); // 'none' | 'work' | 'off' | 'holiday'
  const [draftWorkFullDay, setDraftWorkFullDay] = useState(true);
  const [draftOffFullDay, setDraftOffFullDay] = useState(true);
  const [draftHolidayFullDay, setDraftHolidayFullDay] = useState(true);
  const [draftStart, setDraftStart] = useState(WORK_START);
  const [draftEnd, setDraftEnd] = useState(WORK_END);
  const [saving, setSaving] = useState(false);
  const DISCLAIMER_KEY = "attendance-calendar:disclaimer-hidden";
  const [showDisclaimer, setShowDisclaimer] = useState(() => {
    try {
      return localStorage.getItem(DISCLAIMER_KEY) !== "1";
    } catch {
      return true;
    }
  });
  const [dontShowAgain, setDontShowAgain] = useState(false);
  const [showRules, setShowRules] = useState(false);
  const handleConfirmDisclaimer = () => {
    if (dontShowAgain) {
      try {
        localStorage.setItem(DISCLAIMER_KEY, "1");
      } catch {}
    }
    setShowDisclaimer(false);
  };
  const captureRef = useRef(null);

  const key = monthKey(year, monthIndex);

  // 每次月份切換（key 改變）時，從 localStorage 讀取該月的資料
  useEffect(() => {
    setLoading(true);
    setLoaded(false);
    try {
      const raw = localStorage.getItem(key);
      setStatusMap(raw ? JSON.parse(raw) : {});
      setStorageError(false);
    } catch (e) {
      // 讀取失敗（例如資料損毀或無痕模式限制）時，畫面顯示為空月份
      setStatusMap({});
      setStorageError(true);
    } finally {
      setLoaded(true);
      setLoading(false);
    }
  }, [key]);

  // statusMap 每次變動就自動存回 localStorage，App 關掉再打開也讀得到。
  // 注意：這裡故意不把 key 放進依賴陣列——只在 statusMap／loaded 真的改變時才存檔，
  // 避免切換月份的那一瞬間，用「還沒更新的舊資料」誤存到「新月份的 key」底下。
  useEffect(() => {
    if (!loaded) return; // 讀取完成前先不要存，避免把剛載入的資料覆蓋成空物件
    try {
      localStorage.setItem(key, JSON.stringify(statusMap));
      setStorageError(false);
    } catch (e) {
      // 儲存失敗（例如容量已滿）時提示使用者，畫面上的狀態仍會保留
      setStorageError(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [statusMap, loaded]);

  useEffect(() => {
    if (activeDay == null) return;
    const entry = statusMap[activeDay];
    if (entry && entry.status === "work") {
      setDraftStatus("work");
      const fullDay =
        entry.fullDay !== undefined ? entry.fullDay : entry.start === WORK_START && entry.end === WORK_END;
      setDraftWorkFullDay(fullDay);
      setDraftStart(entry.start || WORK_START);
      setDraftEnd(entry.end || WORK_END);
    } else if (entry && entry.status === "off") {
      setDraftStatus("off");
      setDraftOffFullDay(!!entry.fullDay);
      setDraftStart(entry.start || WORK_START);
      setDraftEnd(entry.end || WORK_END);
    } else if (entry && entry.status === "holiday") {
      setDraftStatus("holiday");
      setDraftHolidayFullDay(!!entry.fullDay);
      setDraftStart(entry.start || WORK_START);
      setDraftEnd(entry.end || WORK_END);
    } else {
      setDraftStatus("none");
      setDraftWorkFullDay(true);
      setDraftOffFullDay(true);
      setDraftHolidayFullDay(true);
      setDraftStart(WORK_START);
      setDraftEnd(WORK_END);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeDay]);

  const commitDay = (day, entry) => {
    setStatusMap((prev) => {
      const next = { ...prev };
      if (entry === null) delete next[day];
      else next[day] = entry;
      return next;
    });
    setActiveDay(null);
  };

  const workPreview = useMemo(() => calcWork(draftStart, draftEnd), [draftStart, draftEnd]);
  const offPreview = useMemo(() => calcOff(draftStart, draftEnd), [draftStart, draftEnd]);

  const selectStatus = (status) => {
    setDraftStatus(status);
    setDraftStart(WORK_START);
    setDraftEnd(WORK_END);
    if (status === "work") setDraftWorkFullDay(true);
    if (status === "off") setDraftOffFullDay(true);
    if (status === "holiday") setDraftHolidayFullDay(true);
  };

  const toggleWorkFullDay = () => {
    setDraftWorkFullDay((prev) => !prev);
    setDraftStart(WORK_START);
    setDraftEnd(WORK_END);
  };

  const toggleOffFullDay = () => {
    setDraftOffFullDay((prev) => !prev);
    setDraftStart(WORK_START);
    setDraftEnd(WORK_END);
  };

  const toggleHolidayFullDay = () => {
    setDraftHolidayFullDay((prev) => !prev);
    setDraftStart(WORK_START);
    setDraftEnd(WORK_END);
  };

  const handleConfirm = () => {
    if (draftStatus === "none") {
      commitDay(activeDay, null);
      return;
    }
    if (draftStatus === "work") {
      if (!workPreview.valid) return;
      commitDay(activeDay, {
        status: "work",
        fullDay: draftWorkFullDay,
        start: draftStart,
        end: draftEnd,
        regularHours: workPreview.regularHours,
        overtimeHours: workPreview.overtimeHours,
        dayFraction: workPreview.dayFraction,
      });
      return;
    }
    if (draftStatus === "off") {
      if (!offPreview.valid) return;
      commitDay(activeDay, {
        status: "off",
        fullDay: draftOffFullDay,
        start: draftStart,
        end: draftEnd,
        offFraction: offPreview.offFraction,
        offHours: offPreview.offHours,
        workHours: offPreview.workHours,
        dayFraction: offPreview.dayFraction,
      });
      return;
    }
    if (draftStatus === "holiday") {
      if (!offPreview.valid) return;
      commitDay(activeDay, {
        status: "holiday",
        fullDay: draftHolidayFullDay,
        start: draftStart,
        end: draftEnd,
        offFraction: offPreview.offFraction,
        offHours: offPreview.offHours,
        workHours: offPreview.workHours,
        dayFraction: offPreview.dayFraction,
      });
    }
  };

  const goMonth = (delta) => {
    let m = monthIndex + delta;
    let y = year;
    if (m < 0) {
      m = 11;
      y -= 1;
    }
    if (m > 11) {
      m = 0;
      y += 1;
    }
    setYear(y);
    setMonthIndex(m);
    setActiveDay(null);
  };

  const goToday = () => {
    setYear(today.getFullYear());
    setMonthIndex(today.getMonth());
    setActiveDay(null);
  };

  const daysInMonth = new Date(year, monthIndex + 1, 0).getDate();
  const firstWeekday = new Date(year, monthIndex, 1).getDay();
  const daysInPrevMonth = new Date(year, monthIndex, 0).getDate();

  const cells = [];
  for (let i = 0; i < firstWeekday; i++) {
    cells.push({ key: `p${i}`, day: daysInPrevMonth - firstWeekday + 1 + i, inMonth: false });
  }
  for (let d = 1; d <= daysInMonth; d++) {
    cells.push({ key: `c${d}`, day: d, inMonth: true });
  }
  const remainder = cells.length % 7;
  if (remainder !== 0) {
    const fill = 7 - remainder;
    for (let i = 1; i <= fill; i++) {
      cells.push({ key: `n${i}`, day: i, inMonth: false });
    }
  }

  const isToday = (day) =>
    year === today.getFullYear() && monthIndex === today.getMonth() && day === today.getDate();

  const stats = useMemo(() => {
    let workDaysSum = 0;
    let overtimeSum = 0;
    let offSum = 0;
    let holidaySum = 0;
    let setCount = 0;
    for (let d = 1; d <= daysInMonth; d++) {
      const entry = statusMap[d];
      if (!entry) continue;
      if (entry.status === "work") {
        workDaysSum += entry.dayFraction || 0;
        overtimeSum += entry.overtimeHours || 0;
        setCount += 1;
      } else if (entry.status === "off") {
        offSum += entry.offFraction != null ? entry.offFraction : 1;
        workDaysSum += entry.dayFraction || 0;
        setCount += 1;
      } else if (entry.status === "holiday") {
        holidaySum += entry.offFraction != null ? entry.offFraction : 1;
        workDaysSum += entry.dayFraction || 0;
        setCount += 1;
      }
    }
    return { workDaysSum, overtimeSum, offSum, holidaySum, unset: daysInMonth - setCount };
  }, [statusMap, daysInMonth]);

  const activeDate = activeDay ? new Date(year, monthIndex, activeDay) : null;
  const confirmDisabled =
    (draftStatus === "work" && !workPreview.valid) ||
    ((draftStatus === "off" || draftStatus === "holiday") && !offPreview.valid);

  // 向瀏覽器要求「持久儲存」，降低空間不足時資料被系統清掉的機率（不保證一定成功）
  useEffect(() => {
    try {
      if (navigator.storage && navigator.storage.persist) {
        navigator.storage.persist().catch(() => {});
      }
    } catch (e) {
      // 不支援就略過
    }
    // 預先載入存圖用的套件，讓離線快取先存起來，之後沒網路也能存圖
    import("html2canvas").catch(() => {});
  }, []);

  const importRef = useRef(null);

  // 備份：把所有月份的資料匯出成一個 JSON 檔
  const handleExportBackup = async () => {
    const data = {};
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.startsWith("attendance-calendar:")) {
          data[k] = JSON.parse(localStorage.getItem(k));
        }
      }
    } catch (e) {
      alert("讀取資料失敗，無法備份");
      return;
    }
    if (Object.keys(data).length === 0) {
      alert("目前沒有可備份的資料");
      return;
    }
    const d = new Date();
    const fileName = `我愛鐵支撐-備份-${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}.json`;
    const blob = new Blob([JSON.stringify(data)], { type: "application/json" });
    const file = new File([blob], fileName, { type: "application/json" });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      try {
        await navigator.share({ files: [file], title: fileName });
      } catch (e) {
        // 使用者取消分享
      }
    } else {
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = fileName;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }
  };

  // 還原：選擇之前備份的 JSON 檔，寫回本機儲存
  const handleImportBackup = (e) => {
    const file = e.target.files && e.target.files[0];
    e.target.value = "";
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const data = JSON.parse(reader.result);
        const keys = Object.keys(data).filter((k) => k.startsWith("attendance-calendar:"));
        if (keys.length === 0) {
          alert("這個檔案不是有效的備份檔");
          return;
        }
        if (!window.confirm(`將還原 ${keys.length} 個月份的資料，會覆蓋目前相同月份的內容，確定嗎？`)) return;
        keys.forEach((k) => localStorage.setItem(k, JSON.stringify(data[k])));
        const current = localStorage.getItem(key);
        setStatusMap(current ? JSON.parse(current) : {});
        alert("還原完成");
      } catch (err) {
        alert("還原失敗，檔案格式不正確");
      }
    };
    reader.readAsText(file);
  };

  const handleSaveImage = async () => {
    if (!captureRef.current || saving) return;
    setSaving(true);
    try {
      // 點擊當下才載入 html2canvas，需先在專案執行：npm install html2canvas
      const mod = await import("html2canvas");
      const html2canvas = mod.default || mod;
      const canvas = await html2canvas(captureRef.current, {
        backgroundColor: "#F4EFE4", // 用紙色當底色，避免存出來背景變透明/變黑
        scale: 2, // 放大解析度，存出來的圖比較清楚
        useCORS: true,
      });
      const fileName = `我愛鐵支撐-${year}-${pad2(monthIndex + 1)}.png`;

      canvas.toBlob(async (blob) => {
        if (!blob) {
          setSaving(false);
          return;
        }
        const file = new File([blob], fileName, { type: "image/png" });

        // 手機上優先用「分享」，可以直接選「儲存影像」存到相簿
        if (navigator.canShare && navigator.canShare({ files: [file] })) {
          try {
            await navigator.share({ files: [file], title: fileName });
          } catch (e) {
            // 使用者取消分享時也會進到這裡，不用特別提示錯誤
          }
        } else {
          // 不支援分享 API 的環境（例如桌機瀏覽器），退回一般下載
          const url = URL.createObjectURL(blob);
          const a = document.createElement("a");
          a.href = url;
          a.download = fileName;
          document.body.appendChild(a);
          a.click();
          document.body.removeChild(a);
          URL.revokeObjectURL(url);
        }
        setSaving(false);
      }, "image/png");
    } catch (e) {
      setSaving(false);
      alert("存圖失敗，請確認專案已執行過 npm install html2canvas");
    }
  };

  return (
    <div className="ac-root">
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Noto+Serif+TC:wght@500;700;900&family=Noto+Sans+TC:wght@400;500;600;700&display=swap');

        .ac-root {
          --paper: #F4EFE4;
          --paper-edge: #EAE1CB;
          --ink: #2A2724;
          --ink-soft: #8A8377;
          --rule: #D9CFB8;
          --work: #2D4159;
          --off: #A3312A;
          --holiday: #3E6E58;
          --sun: #9A4A3C;
          --gold-wash: #E8D19B;
          font-family: 'Noto Sans TC', sans-serif;
          color: var(--ink);
          max-width: 420px;
          margin: 0 auto;
          padding: 18px 0;
          box-sizing: border-box;
        }
        .ac-root * { box-sizing: border-box; }

        .ac-ring-wrap { display:flex; justify-content:center; }
        .ac-ring { width:26px; height:26px; border-radius:50%; background:var(--rule); position:relative; margin-bottom:-13px; z-index:2; }
        .ac-ring::after { content:""; position:absolute; inset:7px; border-radius:50%; background:var(--paper); }

        .ac-card {
          position: relative;
          background: var(--paper);
          border: 1px solid var(--rule);
          border-radius: 21px;
          padding: 34px 23px 23px;
          box-shadow: 0 14px 32px -16px rgba(42,39,36,0.45);
        }

        .ac-header { display:flex; align-items:center; justify-content:center; gap:21px; }
        .ac-nav { background:none; border:1px solid var(--rule); border-radius:10px; padding:8px; color:var(--ink); cursor:pointer; display:flex; align-items:center; justify-content:center; }
        .ac-nav:hover { background: var(--paper-edge); }
        .ac-title { text-align:center; cursor:pointer; user-select:none; min-width:156px; }
        .ac-year { display:block; font-size:18px; color:var(--ink-soft); }
        .ac-month { font-family:'Noto Serif TC', serif; font-weight:900; font-size:49px; line-height:1.15; }

        .ac-hint { text-align:center; font-size:18px; color:var(--ink-soft); margin: 5px 0 21px; }

        .ac-weekrow { display:grid; grid-template-columns: repeat(7, minmax(0, 1fr)); margin-bottom:4px; }
        .ac-weekday { text-align:center; font-size:18px; font-weight:600; color:var(--ink-soft); padding-bottom:8px; }
        .ac-weekday.is-sun { color: var(--sun); }

        .ac-grid { display:grid; grid-template-columns: repeat(7, minmax(0, 1fr)); gap:3px; }
        .ac-cell {
          position: relative;
          display:flex; flex-direction:column; align-items:center; justify-content:center; gap:3px;
          border:none; background:transparent; border-radius:10px;
          font-family:'Noto Sans TC', sans-serif; color:var(--ink); cursor:pointer;
          transition: background-color .15s ease;
          padding:8px 0; min-width:0; min-height:0; box-sizing:border-box; overflow-x:hidden;
        }
        .ac-cell:not(.is-outside):hover { background: var(--paper-edge); }
        .ac-cell.is-outside { color: var(--ink-soft); opacity:.32; cursor:default; }
        .ac-cell.is-today { background: var(--gold-wash); }
        .ac-cell.is-today:hover { background: var(--gold-wash); }

        .ac-daynum {
          font-weight:600; font-size:21px; line-height:1; display:flex; align-items:center; justify-content:center; flex-shrink:0;
          width:42px; height:42px; aspect-ratio:1; border:2px solid transparent; border-radius:50%; box-sizing:border-box;
        }
        .ac-daynum.is-ring {
          border-color: var(--off); color:var(--off); font-weight:700;
        }
        .ac-daynum.is-ring-half { border-style: dashed; }
        .ac-daynum.is-ring-holiday { border-color: var(--holiday); color: var(--holiday); }
        .ac-worklabel { font-size:14px; color:var(--ink-soft); line-height:1; white-space:nowrap; }
        .ac-worklabel.is-placeholder { visibility: hidden; }
        .ac-worklabel .ac-ot { color: var(--off); font-weight:700; margin-left:1px; }

        .ac-stats { display:grid; grid-template-columns: repeat(4, minmax(0, 1fr)); border-top:1px solid var(--rule); margin-top:21px; padding-top:18px; }
        .ac-stat { text-align:center; border-right:1px solid var(--rule); min-width:0; overflow:hidden; }
        .ac-stat:last-child { border-right:none; }
        .ac-stat-num { font-family:'Noto Serif TC', serif; font-weight:700; font-size:34px; line-height:1; color:var(--ink); }
        .ac-stat-num.n-work { color: var(--work); }
        .ac-stat-sub { font-size:16px; line-height:1; margin-top:5px; color:var(--work); font-weight:700; }
        .ac-stat-num.n-off { color: var(--off); }
        .ac-stat-num.n-holiday { color: var(--holiday); }
        .ac-stat-num.n-unset { color: var(--ink-soft); }
        .ac-stat-label { font-size:17px; color:var(--ink-soft); margin-top:5px; }

        .ac-overtime-line { text-align:center; font-size:18px; color:var(--ink-soft); margin-top:13px; }
        .ac-overtime-line b { color: var(--off); font-family:'Noto Serif TC', serif; }

        .ac-note { text-align:center; font-size:14px; color:var(--ink-soft); margin-top:13px; }


        .ac-backdrop {
          position: fixed; inset:0; background: rgba(42,39,36,0.45);
          display:flex; align-items:center; justify-content:center; padding:20px; z-index:50;
          animation: ac-fade .15s ease;
        }
        .ac-sheet {
          background: var(--paper); border-radius:18px; padding:29px 23px 26px; width:100%; max-width:416px;
          position:relative; box-shadow:0 22px 44px -12px rgba(0,0,0,.4);
          animation: ac-pop .15s ease;
          max-height: 86vh; overflow-y: auto;
        }
        @keyframes ac-fade { from{opacity:0} to{opacity:1} }
        @keyframes ac-pop { from{opacity:0; transform:scale(.95)} to{opacity:1; transform:scale(1)} }
        .ac-close { position:absolute; top:13px; right:13px; background:none; border:none; color:var(--ink-soft); cursor:pointer; padding:5px; display:flex; }
        .ac-sheet-date { font-family:'Noto Serif TC', serif; font-weight:700; font-size:30px; text-align:center; margin-bottom:21px; }
        .ac-sheet-weekday { font-family:'Noto Sans TC', sans-serif; font-weight:400; font-size:20px; color:var(--ink-soft); margin-left:8px; }

        .ac-seg { display:flex; border:1px solid var(--rule); border-radius:10px; overflow:hidden; margin-bottom:18px; }
        .ac-seg button { flex:1; padding:14px 5px; font-size:20px; font-weight:600; background:var(--paper); color:var(--ink-soft); cursor:pointer; border:none; border-right:1px solid var(--rule); transition: background-color .15s ease, color .15s ease; }
        .ac-seg button:last-child { border-right:none; }
        .ac-seg button.is-active.seg-none { background:var(--ink-soft); color:#fff; }
        .ac-seg button.is-active.seg-work { background:var(--work); color:#fff; }
        .ac-seg button.is-active.seg-off { background:var(--off); color:#fff; }
        .ac-seg button.is-active.seg-holiday { background:var(--holiday); color:#fff; }

        /* 工作日／排休共用同一個時間列位置，避免切換時版面跳動 */
        .ac-timerow { display:flex; align-items:flex-end; gap:10px; margin-bottom:13px; }
        .ac-timefield { flex:1; min-width:0; display:flex; flex-direction:column; gap:5px; font-size:17px; color:var(--ink-soft); }
        .ac-timefield input {
          font-family:'Noto Sans TC', sans-serif; font-size:22px; color:var(--ink);
          border:1px solid var(--rule); border-radius:10px; padding:12px 8px; background:#fff; width:100%;
        }
        .ac-timefield input:disabled { background: var(--paper-edge); color: var(--ink-soft); opacity:.7; cursor:not-allowed; }

        .ac-toggle-row { display:flex; justify-content:flex-end; margin: -5px 0 16px; }
        .ac-fullday-toggle {
          padding:10px 23px;
          font-size:18px; font-weight:700; border-radius:10px;
          border:1.5px solid var(--off); background:var(--off); color:#fff; cursor:pointer;
          white-space:nowrap; transition: background-color .15s ease, color .15s ease;
        }
        .ac-fullday-toggle.is-off { background:var(--paper); color:var(--off); }
        .ac-fullday-toggle-work { border-color: var(--work); background: var(--work); }
        .ac-fullday-toggle-work.is-off { background:var(--paper); color:var(--work); border-color: var(--work); }
        .ac-fullday-toggle-holiday { border-color: var(--holiday); background: var(--holiday); }
        .ac-fullday-toggle-holiday.is-off { background:var(--paper); color:var(--holiday); border-color: var(--holiday); }

        .ac-preview { font-size:20px; text-align:center; color:var(--ink-soft); margin-bottom:8px; min-height:23px; }
        .ac-preview b { color:var(--ink); font-weight:700; }
        .ac-preview-ot { color: var(--off); }
        .ac-preview-warn { color: var(--off); }

        .ac-rule-note { font-size:17px; color:var(--ink-soft); text-align:center; margin-bottom:18px; line-height:1.5; }

        .ac-confirm {
          width:100%; padding:18px; border-radius:10px; border:none; background:var(--ink); color:#fff;
          font-size:22px; font-weight:700; cursor:pointer; transition: opacity .15s ease;
        }
        .ac-confirm:disabled { opacity:.4; cursor:not-allowed; }

        button:focus-visible { outline: 2px solid var(--work); outline-offset:2px; }

        .ac-save-image {
          width:100%; margin-top:14px; padding:12px; border-radius:10px; border:1px solid var(--ink);
          background:var(--ink); color:#fff; font-family:'Noto Sans TC', sans-serif; font-size:14px; font-weight:700;
          cursor:pointer; display:flex; align-items:center; justify-content:center; gap:8px;
          transition: opacity .15s ease;
        }
        .ac-save-image:disabled { opacity:.5; cursor:not-allowed; }
        .ac-save-image:not(:disabled):hover { opacity:.9; }

        .ac-backup-row { display:flex; gap:10px; margin-top:10px; }
        .ac-backup-btn {
          flex:1; padding:14px 8px; border-radius:10px; border:1.5px solid var(--ink); background:transparent; color:var(--ink);
          font-family:'Noto Sans TC', sans-serif; font-size:17px; font-weight:700; cursor:pointer;
          display:flex; align-items:center; justify-content:center; gap:8px;
        }
        .ac-backup-btn:hover { background: var(--paper-edge); }

        .ac-disclaimer-backdrop { z-index: 100; }
        .ac-disclaimer-title { font-family:'Noto Serif TC', serif; font-weight:900; font-size:28px; text-align:center; margin-bottom:16px; }
        .ac-disclaimer { max-height:88vh; overflow-y:auto; }
        .ac-card-box { border:1.5px solid var(--ink); border-radius:12px; padding:14px 14px 4px; margin-bottom:14px; background: var(--paper-edge); }
        .ac-card-title { font-family:'Noto Serif TC', serif; font-weight:900; font-size:22px; margin-bottom:8px; }
        .ac-disclaimer-list { margin:0 0 12px; padding-left:26px; font-size:18px; line-height:1.7; color:var(--ink); }
        .ac-disclaimer-list li { margin-bottom:10px; }
        .ac-dontshow { display:flex; align-items:center; justify-content:center; gap:12px; margin:6px 0 14px; font-size:22px; color:var(--ink); cursor:pointer; }
        .ac-dontshow input { width:28px; height:28px; accent-color: var(--work); cursor:pointer; margin:0; }
      `}</style>

      <div ref={captureRef} className="ac-capture">
      <div className="ac-ring-wrap">
        <div className="ac-ring" aria-hidden="true" />
      </div>
      <div className="ac-card">
        <div className="ac-header">
          <button className="ac-nav" onClick={() => goMonth(-1)} aria-label="上個月">
            <ChevronLeft size={29} />
          </button>
          <div className="ac-title" onClick={goToday} title="回到本月">
            <span className="ac-year">{year} 年</span>
            <span className="ac-month">{monthIndex + 1} 月</span>
          </div>
          <button className="ac-nav" onClick={() => goMonth(1)} aria-label="下個月">
            <ChevronRight size={29} />
          </button>
        </div>
        <p className="ac-hint">點選日期，標記出工、排休或公休</p>

        <div className="ac-weekrow">
          {WEEKDAYS.map((w, i) => (
            <div key={w} className={`ac-weekday ${i === 0 ? "is-sun" : ""}`}>
              {w}
            </div>
          ))}
        </div>

        <div className="ac-grid">
          {cells.map((cell) => {
            const entry = cell.inMonth ? statusMap[cell.day] : undefined;
            const todayFlag = cell.inMonth && isToday(cell.day);
            const isOff = entry && entry.status === "off";
            const isHoliday = entry && entry.status === "holiday";
            const isRestType = isOff || isHoliday;
            const isHalfRest = isRestType && (entry.offFraction || 0) < 1;
            const hasWorkHours = entry && (entry.status === "work" || (isRestType && entry.dayFraction > 0));
            const hours = entry ? (entry.status === "work" ? entry.regularHours : entry.workHours) : 0;
            return (
              <button
                key={cell.key}
                className={`ac-cell ${!cell.inMonth ? "is-outside" : ""} ${todayFlag ? "is-today" : ""}`}
                disabled={!cell.inMonth}
                onClick={() => cell.inMonth && setActiveDay(cell.day)}
              >
                <span
                  className={`ac-daynum ${isRestType ? "is-ring" : ""} ${isHoliday ? "is-ring-holiday" : ""} ${
                    isHalfRest ? "is-ring-half" : ""
                  }`}
                >
                  {cell.day}
                </span>
                <span className={`ac-worklabel ${hasWorkHours ? "" : "is-placeholder"}`}>
                  {hasWorkHours ? (
                    <>
                      {fmt(hours, 2)}h
                      {entry.status === "work" && entry.overtimeHours > 0 && (
                        <span className="ac-ot">+{fmt(entry.overtimeHours, 2)}</span>
                      )}
                    </>
                  ) : (
                    "0h"
                  )}
                </span>
              </button>
            );
          })}
        </div>

        <div className="ac-stats">
          <div className="ac-stat">
            <div className="ac-stat-num n-work">{loading ? "–" : fmt(stats.workDaysSum, 3)}</div>
            {!loading && stats.overtimeSum > 0 && (
              <div className="ac-stat-sub">{fmt(stats.workDaysSum + stats.overtimeSum / 8, 2)}天</div>
            )}
            <div className="ac-stat-label">出工</div>
          </div>
          <div className="ac-stat">
            <div className="ac-stat-num n-off">{loading ? "–" : fmt(stats.offSum, 2)}</div>
            <div className="ac-stat-label">排休</div>
          </div>
          <div className="ac-stat">
            <div className="ac-stat-num n-holiday">{loading ? "–" : fmt(stats.holidaySum, 2)}</div>
            <div className="ac-stat-label">公休</div>
          </div>
          <div className="ac-stat">
            <div className="ac-stat-num n-unset">{loading ? "–" : stats.unset}</div>
            <div className="ac-stat-label">未排定</div>
          </div>
        </div>
        {!loading && stats.overtimeSum > 0 && (
          <p className="ac-overtime-line">
            本月加班共 <b>{fmt(stats.overtimeSum, 2)}</b> 小時
          </p>
        )}
        {storageError && <p className="ac-note">＊本機儲存空間無法寫入（可能是無痕模式或容量已滿），資料可能無法保留</p>}
      </div>
      </div>

      {activeDay && (
        <div className="ac-backdrop" onClick={() => setActiveDay(null)}>
          <div className="ac-sheet" onClick={(e) => e.stopPropagation()}>
            <button className="ac-close" onClick={() => setActiveDay(null)} aria-label="關閉">
              <X size={29} />
            </button>
            <div className="ac-sheet-date">
              {monthIndex + 1} 月 {activeDay} 日
              <span className="ac-sheet-weekday">星期{WEEKDAYS[activeDate.getDay()]}</span>
            </div>

            <div className="ac-seg">
              <button className={`seg-none ${draftStatus === "none" ? "is-active" : ""}`} onClick={() => selectStatus("none")}>
                未排定
              </button>
              <button className={`seg-work ${draftStatus === "work" ? "is-active" : ""}`} onClick={() => selectStatus("work")}>
                出工
              </button>
              <button className={`seg-off ${draftStatus === "off" ? "is-active" : ""}`} onClick={() => selectStatus("off")}>
                排休
              </button>
              <button
                className={`seg-holiday ${draftStatus === "holiday" ? "is-active" : ""}`}
                onClick={() => selectStatus("holiday")}
              >
                公休
              </button>
            </div>

            {draftStatus === "work" && (
              <>
                <div className="ac-timerow">
                  <label className="ac-timefield">
                    <span>開始時間</span>
                    <input
                      type="time"
                      value={draftStart}
                      disabled={draftWorkFullDay}
                      onChange={(e) => setDraftStart(e.target.value)}
                    />
                  </label>
                  <label className="ac-timefield">
                    <span>結束時間</span>
                    <input
                      type="time"
                      value={draftEnd}
                      disabled={draftWorkFullDay}
                      onChange={(e) => setDraftEnd(e.target.value)}
                    />
                  </label>
                </div>
                <div className="ac-toggle-row">
                  <button
                    type="button"
                    className={`ac-fullday-toggle ac-fullday-toggle-work ${draftWorkFullDay ? "" : "is-off"}`}
                    onClick={toggleWorkFullDay}
                  >
                    整日
                  </button>
                </div>
              </>
            )}

            {draftStatus === "off" && (
              <>
                <div className="ac-timerow">
                  <label className="ac-timefield">
                    <span>開始時間</span>
                    <input
                      type="time"
                      value={draftStart}
                      disabled={draftOffFullDay}
                      onChange={(e) => setDraftStart(e.target.value)}
                    />
                  </label>
                  <label className="ac-timefield">
                    <span>結束時間</span>
                    <input
                      type="time"
                      value={draftEnd}
                      disabled={draftOffFullDay}
                      onChange={(e) => setDraftEnd(e.target.value)}
                    />
                  </label>
                </div>
                <div className="ac-toggle-row">
                  <button
                    type="button"
                    className={`ac-fullday-toggle ${draftOffFullDay ? "" : "is-off"}`}
                    onClick={toggleOffFullDay}
                  >
                    整日
                  </button>
                </div>
              </>
            )}

            {draftStatus === "holiday" && (
              <>
                <div className="ac-timerow">
                  <label className="ac-timefield">
                    <span>開始時間</span>
                    <input
                      type="time"
                      value={draftStart}
                      disabled={draftHolidayFullDay}
                      onChange={(e) => setDraftStart(e.target.value)}
                    />
                  </label>
                  <label className="ac-timefield">
                    <span>結束時間</span>
                    <input
                      type="time"
                      value={draftEnd}
                      disabled={draftHolidayFullDay}
                      onChange={(e) => setDraftEnd(e.target.value)}
                    />
                  </label>
                </div>
                <div className="ac-toggle-row">
                  <button
                    type="button"
                    className={`ac-fullday-toggle ac-fullday-toggle-holiday ${draftHolidayFullDay ? "" : "is-off"}`}
                    onClick={toggleHolidayFullDay}
                  >
                    整日
                  </button>
                </div>
              </>
            )}

            {draftStatus === "work" && (
              <div className="ac-preview">
                {workPreview.valid ? (
                  <>
                    正常工時 <b>{fmt(workPreview.regularHours, 2)}</b> 小時（<b>{fmt(workPreview.dayFraction, 3)}</b> 天）
                    {workPreview.overtimeHours > 0 && (
                      <span className="ac-preview-ot"> ・加班 {fmt(workPreview.overtimeHours, 2)} 小時</span>
                    )}
                  </>
                ) : (
                  <span className="ac-preview-warn">結束時間需晚於開始時間</span>
                )}
              </div>
            )}
            {draftStatus === "work" && (
              <p className="ac-rule-note">
                點「整日」可切換標準全天／自訂時數；午休 12:00–13:00 不計工時，正常工時滿 8 小時算 1 天，17:00 後為加班
              </p>
            )}

            {draftStatus === "off" && (
              <div className="ac-preview">
                {offPreview.valid ? (
                  draftOffFullDay ? (
                    <>整日排休（<b>1</b> 天），不列入工作時數</>
                  ) : (
                    <>
                      排休 <b>{fmt(offPreview.offHours, 2)}</b> 小時（<b>{fmt(offPreview.offFraction, 3)}</b> 天）
                      ・其餘出工 <b>{fmt(offPreview.workHours, 2)}</b> 小時（<b>{fmt(offPreview.dayFraction, 3)}</b> 天）
                    </>
                  )
                ) : (
                  <span className="ac-preview-warn">結束時間需晚於開始時間</span>
                )}
              </div>
            )}
            {draftStatus === "off" && (
              <p className="ac-rule-note">
                點「整日」可切換整天排休／自訂時段；未列入排休、落在 08:00–17:00（扣除午休）的時間視為當日出工
              </p>
            )}

            {draftStatus === "holiday" && (
              <div className="ac-preview">
                {offPreview.valid ? (
                  draftHolidayFullDay ? (
                    <>整日公休（<b>1</b> 天），不列入工作時數</>
                  ) : (
                    <>
                      公休 <b>{fmt(offPreview.offHours, 2)}</b> 小時（<b>{fmt(offPreview.offFraction, 3)}</b> 天）
                      ・其餘出工 <b>{fmt(offPreview.workHours, 2)}</b> 小時（<b>{fmt(offPreview.dayFraction, 3)}</b> 天）
                    </>
                  )
                ) : (
                  <span className="ac-preview-warn">結束時間需晚於開始時間</span>
                )}
              </div>
            )}
            {draftStatus === "holiday" && (
              <p className="ac-rule-note">
                點「整日」可切換整天公休／自訂時段；未列入公休、落在 08:00–17:00（扣除午休）的時間視為當日出工
              </p>
            )}

            <button className="ac-confirm" disabled={confirmDisabled} onClick={handleConfirm}>
              完成
            </button>
          </div>
        </div>
      )}

      <button className="ac-save-image" onClick={handleSaveImage} disabled={saving}>
        <Download size={16} />
        {saving ? "產生圖片中…" : "存圖"}
      </button>

      <div className="ac-backup-row">
        <button className="ac-backup-btn" onClick={handleExportBackup}>
          <Download size={16} />
          備份資料
        </button>
        <button className="ac-backup-btn" onClick={() => importRef.current && importRef.current.click()}>
          <Upload size={16} />
          還原資料
        </button>
        <button className="ac-backup-btn" onClick={() => setShowRules(true)}>
          規則
        </button>
        <input
          ref={importRef}
          type="file"
          accept=".json,application/json"
          style={{ display: "none" }}
          onChange={handleImportBackup}
        />
      </div>

      {(showDisclaimer || showRules) && (
        <div className="ac-backdrop ac-disclaimer-backdrop">
          <div className="ac-sheet ac-disclaimer" role="dialog" aria-modal="true" aria-label="免責聲明與出勤數規則">
            <div className="ac-disclaimer-title">免責聲明與出勤數規則</div>
            <div className="ac-card-box">
              <div className="ac-card-title">免責聲明</div>
              <ol className="ac-disclaimer-list">
                <li>本 App 由棋傑二次反坎製作。</li>
                <li>App 內的天數統計僅供參考，非官方資料，一切以官方公告為準。</li>
                <li>所有個人資料皆不收集、不上傳，僅儲存在您自己的手機裡。</li>
                <li>
                  請養成定期「存圖」與「備份資料」的好習慣，以免網頁暫存記憶體被清空導致資料遺失；
                  因資料遺失所造成的一切損失，本人概不負責。
                </li>
              </ol>
            </div>
            <div className="ac-card-box">
              <div className="ac-card-title">出勤數規則</div>
              <ol className="ac-disclaimer-list">
                <li>公假、事假、工傷假、公休會包含在最低出勤的 22 天裡，但不計薪。</li>
                <li>每月加班時數 8 小時為 1 天。</li>
                <li>每月出工滿 25 日，且無遲到、病假、臨時請假，為全勤。</li>
              </ol>
            </div>
            {showRules && !showDisclaimer ? (
              <button className="ac-confirm" onClick={() => setShowRules(false)}>
                關閉
              </button>
            ) : (
              <>
                <label className="ac-dontshow">
                  <input
                    type="checkbox"
                    checked={dontShowAgain}
                    onChange={(e) => setDontShowAgain(e.target.checked)}
                  />
                  <span>不再顯示</span>
                </label>
                <button className="ac-confirm" onClick={handleConfirmDisclaimer}>
                  我知道了
                </button>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
