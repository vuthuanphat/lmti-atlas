import { useId } from 'react';

export function SectionTabs<T extends string>({ label, value, items, disabled, onChange }: {
  label: string; value: T; items: readonly { id: T; label: string; panel: string }[];
  disabled: boolean; onChange: (value: T) => void;
}) {
  const prefix = useId();
  return <div className="section-tabs" role="tablist" aria-label={label}>
    {items.map((item, index) => <button key={item.id} type="button" role="tab" id={`${prefix}-${item.id}`}
      aria-selected={value === item.id} aria-controls={item.panel} tabIndex={value === item.id ? 0 : -1}
      disabled={disabled} onClick={() => onChange(item.id)} onKeyDown={event => {
        if (disabled) return;
        const target = event.key === 'ArrowRight' ? (index + 1) % items.length : event.key === 'ArrowLeft' ?
          (index + items.length - 1) % items.length : event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : -1;
        if (target < 0) return;
        event.preventDefault(); onChange(items[target].id);
        document.getElementById(`${prefix}-${items[target].id}`)?.focus();
      }}>{item.label}</button>)}
  </div>;
}
