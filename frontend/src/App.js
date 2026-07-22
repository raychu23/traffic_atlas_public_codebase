import React, { lazy, Suspense } from 'react';
import { BrowserRouter as Router, Routes, Route, Navigate } from 'react-router-dom';
import './App.css';
import UserRegistration from './components/UserRegistration';
import Login from './components/Login';
import UploadLanding from './components/UploadLanding';
import UploadMetadata from './components/UploadMetadata';
import UploadConsent from './components/UploadConsent';
import DatasetDiscovery from './components/DatasetDiscovery';
import DatasetDetail from './components/DatasetDetail';
import DownloadMetadata from './components/DownloadMetadata';
import DownloadConsent from './components/DownloadConsent';
import UploadFullDataset from './components/UploadFullDataset';
import UploadVideo from './components/UploadVideo';
import UploadVideoDetails from './components/UploadVideoDetails';
import AdminDashboard from './components/AdminDashboard';
import Navbar from './components/Navbar';
import PageTransition from './components/PageTransition';
import DatasetUploadGuidelines from './components/DatasetUploadGuidelines';
import ProtectedRoute from './components/ProtectedRoute';
import AdminRoute from './components/AdminRoute';
import ForgotPassword from './components/ForgotPassword';
import Profile from './components/Profile';

const DatasetEmbeddingAnalysis = lazy(() => import('./components/DatasetEmbeddingAnalysis'));

function App() {
  return (
    <Router future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      <div className="App">
        <Navbar />
        <PageTransition>
          <Routes>
            <Route path="/" element={<Navigate to="/discover" replace />} />
            <Route path="/register" element={<UserRegistration />} />
            <Route path="/login" element={<Login />} />
            <Route path="/forgot-password" element={<ForgotPassword />} />
            <Route
              path="/upload"
              element={
                <ProtectedRoute>
                  <UploadLanding />
                </ProtectedRoute>
              }
            />
            <Route
              path="/upload/metadata"
              element={
                <ProtectedRoute>
                  <UploadMetadata />
                </ProtectedRoute>
              }
            />
            <Route
              path="/upload/video"
              element={
                <ProtectedRoute>
                  <UploadVideo />
                </ProtectedRoute>
              }
            />
            <Route
              path="/upload/video/details"
              element={
                <ProtectedRoute>
                  <UploadVideoDetails />
                </ProtectedRoute>
              }
            />
            <Route
              path="/upload/full/:requestId"
              element={
                <ProtectedRoute>
                  <UploadFullDataset />
                </ProtectedRoute>
              }
            />
            <Route path="/upload/guidelines" element={<DatasetUploadGuidelines />} />
            <Route path="/upload/consent" element={<UploadConsent />} />
            <Route path="/discover" element={<DatasetDiscovery />} />
            <Route path="/dataset/:datasetId" element={<DatasetDetail />} />
            <Route
              path="/dataset/:datasetId/analysis"
              element={
                <Suspense fallback={<main aria-live="polite">Loading analysis…</main>}>
                  <DatasetEmbeddingAnalysis />
                </Suspense>
              }
            />
            <Route
              path="/download/:datasetId/metadata"
              element={
                <ProtectedRoute>
                  <DownloadMetadata />
                </ProtectedRoute>
              }
            />
            <Route
              path="/download/:datasetId/consent"
              element={
                <ProtectedRoute>
                  <DownloadConsent />
                </ProtectedRoute>
              }
            />
            <Route
              path="/profile"
              element={
                <ProtectedRoute>
                  <Profile />
                </ProtectedRoute>
              }
            />
            <Route
              path="/admin"
              element={
                <AdminRoute>
                  <AdminDashboard />
                </AdminRoute>
              }
            />
          </Routes>
        </PageTransition>
      </div>
    </Router>
  );
}

export default App;
