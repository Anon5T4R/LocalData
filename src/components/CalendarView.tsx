// Calendário mensal: registros aparecem no dia do campo de data escolhido.

import { useState } from "react";
import { activeTable, activeView, useStore } from "../state/store";
import { t, type MessageKey } from "../lib/i18n";

const WEEKDAYS = [0, 1, 2, 3, 4, 5, 6];
const monthName = (m: number) => t(`cal.mon${m}` as MessageKey);
const weekdayName = (i: number) => t(`cal.wd${i}` as MessageKey);

function iso(y: number, m: number, d: number): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${y}-${p(m + 1)}-${p(d)}`;
}

export function CalendarView() {
  const store = useStore();
  const table = activeTable(store);
  const view = activeView(store);
  const now = new Date();
  const [ym, setYm] = useState<{ y: number; m: number }>({ y: now.getFullYear(), m: now.getMonth() });

  if (!table || !view) return null;

  const dateField = table.fields.find((f) => f.id === view.config.dateField && f.type === "date");
  const dateFields = table.fields.filter((f) => f.type === "date");

  if (!dateField) {
    return (
      <div className="view-setup">
        <p>{t("cal.hint")}</p>
        {dateFields.length ? (
          <select
            className="input"
            value=""
            onChange={(e) => e.target.value && void store.patchViewConfig({ dateField: e.target.value })}
          >
            <option value="">{t("common.chooseField")}</option>
            {dateFields.map((f) => (
              <option key={f.id} value={f.id}>
                {f.name}
              </option>
            ))}
          </select>
        ) : (
          <p className="muted">{t("cal.needDate")}</p>
        )}
      </div>
    );
  }

  const firstDay = new Date(ym.y, ym.m, 1);
  const startOffset = firstDay.getDay();
  const daysInMonth = new Date(ym.y, ym.m + 1, 0).getDate();
  const cells: (number | null)[] = [
    ...Array.from({ length: startOffset }, () => null),
    ...Array.from({ length: daysInMonth }, (_, i) => i + 1),
  ];
  while (cells.length % 7 !== 0) cells.push(null);

  const byDay = new Map<string, typeof store.rows>();
  for (const r of store.rows) {
    const v = r.cells[dateField.id];
    if (typeof v !== "string" || !v) continue;
    const day = v.slice(0, 10);
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day)!.push(r);
  }

  const primary = table.fields[0];
  const todayIso = iso(now.getFullYear(), now.getMonth(), now.getDate());

  return (
    <div className="calendar">
      <div className="calendar-head">
        <button className="btn" onClick={() => setYm(ym.m === 0 ? { y: ym.y - 1, m: 11 } : { y: ym.y, m: ym.m - 1 })}>
          ←
        </button>
        <h3>{t("cal.monthYear", { month: monthName(ym.m), year: ym.y })}</h3>
        <button className="btn" onClick={() => setYm(ym.m === 11 ? { y: ym.y + 1, m: 0 } : { y: ym.y, m: ym.m + 1 })}>
          →
        </button>
        <button className="btn" onClick={() => setYm({ y: now.getFullYear(), m: now.getMonth() })}>
          {t("cal.today")}
        </button>
      </div>
      <div className="calendar-grid">
        {WEEKDAYS.map((i) => (
          <div key={i} className="calendar-wd">
            {weekdayName(i)}
          </div>
        ))}
        {cells.map((d, i) => {
          const dayIso = d ? iso(ym.y, ym.m, d) : "";
          const items = d ? byDay.get(dayIso) ?? [] : [];
          return (
            <div key={i} className={"calendar-day" + (d ? "" : " off") + (dayIso === todayIso ? " today" : "")}>
              {d && (
                <>
                  <div className="calendar-dayno">
                    <span>{d}</span>
                    <button
                      className="calendar-add"
                      title={t("cal.addDay")}
                      onClick={() => {
                        void store
                          .addRecord({ [dateField.id]: dayIso })
                          .then((id) => id != null && store.setOpenRecord(id));
                      }}
                    >
                      +
                    </button>
                  </div>
                  {items.slice(0, 4).map((r) => (
                    <div key={r.id} className="calendar-item" onClick={() => store.setOpenRecord(r.id)}>
                      {primary && r.cells[primary.id] != null && r.cells[primary.id] !== ""
                        ? String(r.cells[primary.id])
                        : `#${r.id}`}
                    </div>
                  ))}
                  {items.length > 4 && <div className="calendar-more">+{items.length - 4}</div>}
                </>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
