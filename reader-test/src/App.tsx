import React, { useState } from 'react';
import { useSheet } from './sheet.context.js';

function App() {
  const { loadFile, sheets, activeSheet, activeSheetData, getSheetData } =
    useSheet();

    const [loading, setLoading] = useState(false)

    const loadSheetData = async (sheetName: string) => {
      setLoading(true)
      await getSheetData(sheetName)
      setLoading(false)
    }

  return (
    <>
      <input type="file" onChange={loadFile} accept=".xls,.xlsx" />
      <ul>
        {sheets.map((sheet: any) => (
          <li key={sheet.name} onClick={() => loadSheetData(sheet.name)}>
            {sheet.name}
          </li>
        ))}
      </ul>
      <div>
        <h1>{activeSheet}</h1>
        {
          loading && <p>Loading...</p>
        }
        <table>
          <tbody>
          {activeSheetData.map((row: any, index: number) => (
            <tr key={`row-${index}`}>
              {row.map((cell: any) => (
                <td key={cell}>{cell}</td>
              ))}
            </tr>
          ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

export default App;
