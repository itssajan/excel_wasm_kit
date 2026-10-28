import { useState, type ReactNode } from "react";

const ACCEPT = ".xlsx,.xlsm,.xlsb,.xls,.ods,.csv";

/** Drop zone + file picker. Children render inside the zone. */
export function FileDrop({ onFile, disabled, className = "", children }: { onFile: (f: File) => void; disabled?: boolean; className?: string; children: ReactNode }) {
  const [over, setOver] = useState(false);
  return (
    <div
      className={`drop ${over ? "over" : ""} ${className}`}
      onDragOver={(e) => {
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        const f = e.dataTransfer.files[0];
        if (f && !disabled) onFile(f);
      }}
    >
      {children}
      <label className="pick">
        Choose file
        <input
          type="file"
          className="sr-only"
          accept={ACCEPT}
          disabled={disabled}
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) onFile(f);
            e.target.value = "";
          }}
        />
      </label>
    </div>
  );
}
