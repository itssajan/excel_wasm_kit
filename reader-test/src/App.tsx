import React, { useState } from 'react';
import { useSheet } from './sheet.context.js';


function App() {

  const {loadFile, sheets} = useSheet();



  return (
    <>
      <input type="file" onChange={loadFile} accept=".xls,.xlsx" />
      <ul>
        {sheets.map((sheet: any) => <li key={sheet.name}>{sheet.name}</li>)}
      </ul>
    </>
  )
}

export default App
