import init, {
  get_worksheet_names,
  get_worksheet_row,
} from '../pkg/saj_wasm_excel_reader.js';
import React, { useEffect, useRef, useState } from 'react';

const delay = (ms: number = 1000) =>
  new Promise((resolve) => setTimeout(resolve, ms));

export function useSheet() {
  const [sheets, setSheets] = useState([]);
  const [activeSheet, setActiveSheet] = useState('');
  const [activeSheetData, setActiveSheetData] = useState<any>([]);
  const [loadingText, setLoadingText] = useState('');

  const [fileData, setFileData] = useState<any>(null);
  const [worker, setWorker] = useState<Worker>();

  const loadRowIntervalRef = useRef<any>();

  useEffect(() => {
    const newWorker = new Worker(
      new URL('./excel.worker.ts', import.meta.url),
      { type: 'module' }
    );

    newWorker.onmessage = (e) => {
      const { type, data } = e.data;

      switch (type) {
        case 'rowData':
          //   console.log('useEffect ~ data:', data);
          if (!data) clearInterval(loadRowIntervalRef.current);
          else {
            setActiveSheetData((prevData: any) => [...prevData, data]);
          }
          break;
        case 'getRowDataError':
          // console.error(data);
          clearInterval(loadRowIntervalRef.current);
          break;
      }
    };

    newWorker.postMessage({ type: 'init' });
    setWorker(newWorker);

    return () => {
      newWorker.terminate();
    };
  }, []);

  const reset = () => {
    setSheets([]);
    setActiveSheet('');
    setActiveSheetData([]);
    setFileData(null);
  };

  const loadFile = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    reset();
    await init();

    const data = new Uint8Array(await file.arrayBuffer());
    setFileData(data);
    try {
      const _data = get_worksheet_names(data);
      const { worksheets } = JSON.parse(_data);
      const visibleSheets = worksheets.filter(
        (sheet: any) => sheet.visibility === 'Visible'
      );
      setSheets(visibleSheets);
    } catch (error) {
      console.log({ error });
    }
  };

  const getSheetData = async (sheetName: string) => {
    setActiveSheetData([]);
    setLoadingText('');
    clearInterval(loadRowIntervalRef.current);
    setActiveSheet(sheetName);
    // const data = fileData;
    let rowIndex = 0;
    loadRowIntervalRef.current = setInterval(() => {
      try {
        setLoadingText(`Loading row ${rowIndex}`);
        worker?.postMessage({
          type: 'getRowData',
          data: fileData,
          sheetName,
          rowIndex,
        });
        rowIndex++;
      } catch (error) {
        console.error(error);
        clearInterval(loadRowIntervalRef.current);
      }
    }, 50);
  };

  return {
    sheets,
    loadFile,
    getSheetData,
    activeSheetData,
    activeSheet,
    loadingText,
  };
}
