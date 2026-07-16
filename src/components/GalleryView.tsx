// Galeria: um cartão por registro, com capa opcional (campo de anexo).

import { activeTable, activeView, useStore, visibleFields } from "../state/store";
import { attachmentThumb, CellDisplay, useAttachments } from "./cells";
import type { RecordRow } from "../lib/types";
import { t } from "../lib/i18n";

export function GalleryView() {
  const store = useStore();
  const table = activeTable(store);
  const view = activeView(store);

  if (!table || !view) return null;

  const coverField = table.fields.find((f) => f.id === view.config.coverField && f.type === "attachment");
  const attachmentFields = table.fields.filter((f) => f.type === "attachment");
  const primary = table.fields[0];
  const fields = visibleFields(table, view)
    .filter((f) => f.id !== primary?.id && f.id !== coverField?.id)
    .slice(0, 4);

  return (
    <div className="gallery-wrap">
      {attachmentFields.length > 0 && (
        <div className="gallery-bar">
          <label>{t("gal.cover")}</label>
          <select
            className="input input-sm"
            value={coverField?.id ?? ""}
            onChange={(e) => void store.patchViewConfig({ coverField: e.target.value || undefined })}
          >
            <option value="">{t("gal.noCover")}</option>
            {attachmentFields.map((f) => (
              <option key={f.id} value={f.id}>
                {f.name}
              </option>
            ))}
          </select>
        </div>
      )}
      <div className="gallery">
        {store.rows.map((r) => (
          <GalleryCard key={r.id} row={r} coverFieldId={coverField?.id} onOpen={() => store.setOpenRecord(r.id)}>
            <div className="card-title">
              {primary && r.cells[primary.id] != null && r.cells[primary.id] !== ""
                ? String(r.cells[primary.id])
                : `#${r.id}`}
            </div>
            {fields.map((f) => {
              const v = r.cells[f.id];
              if (v == null || v === "" || (Array.isArray(v) && !v.length)) return null;
              return (
                <div key={f.id} className="card-line">
                  <span className="card-label">{f.name}</span>
                  <CellDisplay field={f} value={v} row={r} table={table} tables={store.schema?.tables ?? []} />
                </div>
              );
            })}
          </GalleryCard>
        ))}
        <button
          className="gallery-card gallery-add"
          onClick={() => void store.addRecord().then((id) => id != null && store.setOpenRecord(id))}
        >
          {t("common.newRecord")}
        </button>
      </div>
    </div>
  );
}

function GalleryCard({
  row,
  coverFieldId,
  onOpen,
  children,
}: {
  row: RecordRow;
  coverFieldId?: string;
  onOpen: () => void;
  children: React.ReactNode;
}) {
  const ids = coverFieldId && Array.isArray(row.cells[coverFieldId]) ? (row.cells[coverFieldId] as string[]) : [];
  useAttachments(ids); // garante que a thumb carregue
  const thumb = ids.map((id) => attachmentThumb(id)).find(Boolean);
  return (
    <div className="gallery-card" onClick={onOpen}>
      {coverFieldId && (
        <div className="gallery-cover">
          {thumb ? <img src={thumb} alt="" /> : <span className="gallery-cover-empty">—</span>}
        </div>
      )}
      <div className="gallery-body">{children}</div>
    </div>
  );
}
