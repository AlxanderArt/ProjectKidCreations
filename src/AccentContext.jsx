import React from 'react';

const AccentContext = React.createContext('#FF5F1F');

export function AccentProvider({ value, children }) {
  return <AccentContext.Provider value={value || '#FF5F1F'}>{children}</AccentContext.Provider>;
}

export function useAccent() {
  return React.useContext(AccentContext);
}
