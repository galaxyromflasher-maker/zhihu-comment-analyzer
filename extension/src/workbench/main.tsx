import React from 'react';
import { createRoot } from 'react-dom/client';
import { WorkbenchApp } from './WorkbenchApp';
import './workbench.css';

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <WorkbenchApp />
  </React.StrictMode>,
);
