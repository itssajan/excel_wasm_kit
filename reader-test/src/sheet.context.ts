import init, { get_worksheet_names, get_worksheet_data } from '../pkg/saj_wasm_excel_reader.js';
import React, { useState } from 'react';

export function useSheet() {
  const [sheets, setSheets] = useState([]);

  const loadFile = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return
    await init();

    const data = new Uint8Array(await file.arrayBuffer());
    try {
      const _data = get_worksheet_names(data);
      const {worksheets} = JSON.parse(_data);
      const visibleSheets = worksheets.filter((sheet: any) => sheet.visibility === 'Visible');
      setSheets(visibleSheets);
    } catch (error) {
      console.log({error})
    }
  };

  return { sheets, loadFile };
}