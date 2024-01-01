import React, { useEffect, useState, useCallback } from 'react';
// import * as excelKit from '@milojs/excel-kit';
import init, { get_worksheet_names } from '../pkg/web';

export type SheetMeta = {
  name: string;
  rows: number;
  visibility: string;
};

export function useSheet() {
  const [sheets, setSheets] = useState<SheetMeta[]>([]);
  const [activeSheet, setActiveSheet] = useState<SheetMeta | null>(null);
  const [activeSheetData, setActiveSheetData] = useState<any[]>([]);
  const [loadingText, setLoadingText] = useState('');
  const [fileData, setFileData] = useState<any>(null);
  const [worker, setWorker] = useState<Worker | null>(null);

  useEffect(() => {
    const newWorker = new Worker(
      new URL('./excel.worker.ts', import.meta.url),
      { type: 'module' }
    );

    newWorker.onmessage = (e) => {
      const { type, data } = e.data;

      switch (type) {
        case 'rowData':
          if (data) {
            // setActiveSheetData((prevData: any) => [...prevData, data]);
            // loadNextRow(data.length + 1); // Load the next row
            setActiveSheetData(prevData => [...prevData, data]);
          }
          break;
        case 'getRowDataError':
          console.error(data);
          break;
      }
    };

    newWorker.postMessage({ type: 'init' });
    setWorker(newWorker);

    return () => {
      newWorker.terminate();
    };
  }, []);

  const reset = useCallback(() => {
    setSheets([]);
    setActiveSheet(null);
    setActiveSheetData([]);
    setFileData(null);
  }, []);

  const loadFile = useCallback(
    async (event: React.ChangeEvent<HTMLInputElement>) => {
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
          (sheet: SheetMeta) => sheet.visibility === 'Visible'
        );
        setSheets(visibleSheets);
      } catch (error) {
        console.error(error);
      }
    },
    [reset]
  );

  const loadNextRow = useCallback((rowIndex: number) => {
    if (activeSheet && rowIndex < activeSheet.rows) {
      setLoadingText(`Loading row ${rowIndex + 1} / ${activeSheet.rows}`);
      worker?.postMessage({
        type: 'getRowData',
        data: fileData,
        sheetName: activeSheet.name,
        rowIndex,
      });
      // Increment rowIndex for the next call
      loadNextRow(rowIndex + 1);
    }
  }, [activeSheet, fileData, worker]);

  useEffect(() => {
    if (activeSheet && fileData) {
      setActiveSheetData([]); // Reset sheet data
      loadNextRow(0); // Start loading rows from the beginning
    }
  }, [activeSheet, fileData, loadNextRow]); // Dependency on activeSheet and fileData



  const getSheetData = useCallback(
    (sheet: SheetMeta) => {
      setActiveSheetData([]);
      setLoadingText('');
      setActiveSheet(sheet);
      loadNextRow(0);
    },
    [loadNextRow]
  );

  return {
    sheets,
    loadFile,
    getSheetData,
    activeSheetData,
    activeSheet,
    loadingText,
  };
}
