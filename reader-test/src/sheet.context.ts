import init, { get_worksheet_names, get_worksheet_data } from '../pkg/saj_wasm_excel_reader.js';
import React, { useState } from 'react';

export function useSheet() {
  const [sheets, setSheets] = useState([]);
  const [activeSheet, setActiveSheet] = useState('');
  const [activeSheetData, setActiveSheetData] = useState([]);

  const [fileData, setFileData] = useState<any>(null);

  const reset = () => {
    setSheets([]);
    setActiveSheet('');
    setActiveSheetData([]);
    setFileData(null);
  }

  const loadFile = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return
    reset();
    await init();

    const data = new Uint8Array(await file.arrayBuffer());
    setFileData(data);
    try {
      const _data = get_worksheet_names(data);
      const {worksheets} = JSON.parse(_data);
      const visibleSheets = worksheets.filter((sheet: any) => sheet.visibility === 'Visible');
      setSheets(visibleSheets);
    } catch (error) {
      console.log({error})
    }
  };

  const getSheetData = async (sheetName: string) => {
    setActiveSheet(sheetName);
    const data = fileData;
    const _data = get_worksheet_data(data, sheetName);
    setActiveSheetData(JSON.parse(_data));
  }

  return { sheets, loadFile, getSheetData, activeSheetData, activeSheet };
}