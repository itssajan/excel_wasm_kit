import React, { useState } from 'react';
import { SheetMeta, useSheet } from './sheet.context.js';

function App() {
  const {
    loadFile,
    sheets,
    activeSheet,
    activeSheetData,
    getSheetData,
    loadingText,
  } = useSheet();

  // const [loading, setLoading] = useState(false)

  const loadSheetData = async (sheet: SheetMeta) => {
    // setLoading(true)
    await getSheetData(sheet);
    // setLoading(false)
  };

  return (
    <div className="p-2 m-2">
      <input type="file" onChange={loadFile} accept=".xls,.xlsx" />
      <ul className="flex space-x-2 bg-slate-300 relative">
        {sheets.map((sheet: SheetMeta) => (
          <li
            className={`p-2 cursor-pointer ${
              activeSheet?.name === sheet.name ? 'font-bold' : ''
            }`}
            key={sheet.name}
            onClick={() => loadSheetData(sheet)}
          >
            {sheet.name}
          </li>
        ))}
        {loadingText && (
          <span className="absolute right-2 top-2 text-sm text-slate-500">
            {loadingText}
          </span>
        )}
      </ul>
      <div>
        <table className="table-fixed">
          <tbody>
            {activeSheetData.map((row: any, index: number) => {
              let clsName = `p-2 text-sm ${
                index % 2 ? 'bg-slate-200 text-slate-700' : ''
              }`;
              return (
                <tr key={`row-${index}`}>
                  <th key={`row-head-${index}`} className={clsName}>
                    {index + 1}
                  </th>
                  {row.map((cell: any, cIndex: number) => (
                    <td className={clsName} key={`cell-${index}-${cIndex}`}>
                      {cell}
                    </td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export default App;
