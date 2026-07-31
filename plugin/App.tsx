/**
 * Ink2Task - Root component
 *
 * Single-screen plugin -- see src/screens/Home.tsx for the settings and the
 * fetch / write / sync workflow. No routing needed.
 *
 * @format
 */
import React from 'react';
import Home from './src/screens/Home';

function App(): React.JSX.Element {
  return <Home />;
}

export default App;
