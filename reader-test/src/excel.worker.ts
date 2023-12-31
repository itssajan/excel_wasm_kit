// excelWorker.js
let wasmModule: any;

self.onmessage = async (e) => {
  //   console.log('self.onmessage= ~ e:', e);
  const { data, type, sheetName, rowIndex } = e.data;

  switch (type) {
    case 'init':
      wasmModule = await import('../pkg/saj_wasm_excel_reader.js');
      await wasmModule.default();
      break;
    case 'getRowData':
      if (!wasmModule) {
        postMessage({ type: 'getRowDataError', message: 'WASM module not initialized' });
        return;
      }
      try {
        const rowJson = wasmModule.get_worksheet_row(data, sheetName, rowIndex);
        postMessage({ type: 'rowData', data: JSON.parse(rowJson) });
      } catch (error: any) {
        console.log('self.onmessage= ~ error:', error);
        postMessage({ type: 'getRowDataError', data: '{message: error.message}' });
      }
      break;
  }
};
