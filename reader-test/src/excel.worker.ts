// excelWorker.js
let wasmModule: any;

self.onmessage = async (e) => {
  //   console.log('self.onmessage= ~ e:', e);
  const { data, type, sheetName, rowIndex } = e.data;

  switch (type) {
    case 'init':
      console.log('self.onmessage= ~ init');
      // wasmModule = await import('../pkg/web/web_index.js');
      wasmModule = await import('@milojs/excel-kit');
      await wasmModule.default();
      break;
    case 'getRowData':
      if (!wasmModule) {
        postMessage({ type: 'getRowDataError', message: 'WASM module not initialized' });
        return;
      }
      try {
        const rowJson = wasmModule.get_worksheet_row(data, sheetName, rowIndex);
        postMessage({ type: 'rowData', data: {
          row: rowJson,
          rowIndex,
        } });
      } catch (error: any) {
        console.log('self.onmessage= ~ error:', error);
        postMessage({ type: 'getRowDataError', error });
      }
      break;
  }
};
