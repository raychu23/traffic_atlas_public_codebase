import React from 'react';
import { Navigate } from 'react-router-dom';
import { getAuthState } from '../services/authState';

function AdminRoute({ children }) {
  const { token, isAdmin } = getAuthState();
  if (!token) {
    return <Navigate to="/login" replace />;
  }
  if (!isAdmin) {
    return <Navigate to="/discover" replace />;
  }
  return children;
}

export default AdminRoute;
