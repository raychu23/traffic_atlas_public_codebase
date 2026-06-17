import React from 'react';
import { useLocation } from 'react-router-dom';

/**
 * Subtle fade/slide when navigating between routes.
 */
function PageTransition({ children }) {
  const location = useLocation();
  return (
    <div key={location.pathname} className="page-transition">
      {children}
    </div>
  );
}

export default PageTransition;
