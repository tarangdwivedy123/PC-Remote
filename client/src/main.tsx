import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { App } from './App';
import { applyTheme, getStoredTheme } from './lib/theme';
// uPlot's stylesheet positions the canvas layers it creates; without it the chart
// renders at the wrong offset. Imported before index.css so Tailwind's utilities
// win any conflict.
import 'uplot/dist/uPlot.min.css';
import './index.css';

// Before the first render: a class change after mount would show one frame of
// the wrong palette, which on a dark-to-light switch is a white flash.
applyTheme(getStoredTheme());

const container = document.getElementById('root');
if (!container) throw new Error('#root is missing from index.html');

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
