import React from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { getAuthState } from '../services/authState';

function ProtectedRoute({ children }) {
  const location = useLocation();
  const { token } = getAuthState();
  if (!token) {
    return <Navigate to="/login" replace state={{ from: location }} />;
  }
  return children;
}

export default ProtectedRoute;
