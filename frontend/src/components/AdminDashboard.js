import React, { useState, useEffect } from 'react';
import {
  getUploadRequests, getDownloadRequests,
  approveUploadRequest, rejectUploadRequest, clarifyUploadRequest,
  approveDownloadRequest, rejectDownloadRequest, clarifyDownloadRequest,
  getUploadRequest, getDownloadRequest,
  getAdminUsers, deleteAdminUser, setAdminUser,
  getRequestHistory,
  downloadAdminSample, getMessages, sendMessage
} from '../services/api';
import './AdminDashboard.css';

const NAV_TABS = [
  { id: 'upload',   label: 'Upload Requests' },
  { id: 'download', label: 'Download Requests' },
  { id: 'users',    label: 'User Management' },
  { id: 'history',  label: 'Request History' },
];

// ─────────────────────────────────────────────────────────────────────────────
// Shared sub-components
// ─────────────────────────────────────────────────────────────────────────────
function StatusBadge({ status }) {
  return <span className={`status-badge ${status?.toLowerCase().replace(/_/g, '-')}`}>{status || 'Unknown'}</span>;
}

function RoleBadge({ isAdmin }) {
  return (
    <span className={`status-badge ${isAdmin ? 'approved' : 'pending'}`}>
      {isAdmin ? '⭐ Admin' : 'User'}
    </span>
  );
}

function AdminChatPanel({ type, requestId, onClose, onThreadUpdated }) {
  const [messages, setMessages] = useState([]);
  const [newMessage, setNewMessage] = useState('');
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);

  useEffect(() => {
    let mounted = true;
    getMessages(type, requestId).then(res => {
      if (mounted && res.success) setMessages(res.messages || []);
      if (mounted) setLoading(false);
    }).catch(() => {
      if (mounted) setLoading(false);
    });
    return () => mounted = false;
  }, [type, requestId]);

  const handleSend = async () => {
    if (!newMessage.trim()) return;
    setSending(true);
    try {
      const res = await sendMessage(type, requestId, newMessage, 'admin');
      if (res.success && res.message) {
        setMessages(prev => [...prev, res.message]);
        setNewMessage('');
        if (onThreadUpdated) onThreadUpdated();
      }
    } catch (e) {
      alert('Failed to send message');
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="clarify-overlay" onClick={onClose}>
      <div className="chat-panel" onClick={e => e.stopPropagation()}>
        <div className="chat-panel-header">
          <span>💬 Request Discussion</span>
          <button className="clarify-close-btn" onClick={onClose}>✕</button>
        </div>
        
        <div className="chat-panel-messages">
          {loading ? (
            <div className="chat-loading"><div className="spinner sm"></div></div>
          ) : messages.length === 0 ? (
            <div className="chat-empty">No messages yet.</div>
          ) : (
            messages.map(msg => (
              <div key={msg.id} className={`chat-bubble ${msg.sender === 'admin' ? 'admin' : 'user'}`}>
                <div className="chat-bubble-sender">{msg.senderLabel}</div>
                <div className="chat-bubble-text">{msg.text}</div>
                <div className="chat-bubble-time">{new Date(msg.timestamp).toLocaleString()}</div>
              </div>
            ))
          )}
        </div>

        <div className="chat-panel-input">
          <textarea
            placeholder="Type your reply here..."
            value={newMessage}
            onChange={e => setNewMessage(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend(); } }}
          />
          <button className="chat-send-btn" onClick={handleSend} disabled={sending || !newMessage.trim()}>
            {sending ? '...' : 'Send'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Request detail modal popup (Change 3 & 4)
// ─────────────────────────────────────────────────────────────────────────────
function RequestModal({ request, onClose, onApprove, onReject, onClarify, isApproving }) {
  const [rejectionReason, setRejectionReason] = useState('');
  const [showRejectForm, setShowRejectForm] = useState(false);

  const metadata = request.type === 'upload'
    ? request.stagingData?.metadata || request.request?.metadata || {}
    : request.downloaderMetadata || {};



  const formatValue = (v) => {
    if (Array.isArray(v)) return v.join(', ') || 'N/A';
    if (v && typeof v === 'object') return JSON.stringify(v);
    if (v === undefined || v === null || v === '') return 'N/A';
    return String(v);
  };

  const renderRows = (items) => items.map(([k, v]) => (
    <div key={k} className="modal-detail-row">
      <span className="modal-detail-key">{k}</span>
      <span className="modal-detail-val">{formatValue(v)}</span>
    </div>
  ));

  const renderSection = (title, items) => (
    <div className="modal-section" key={title}>
      <div className="modal-section-title">{title}</div>
      {renderRows(items)}
    </div>
  );

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-container" onClick={e => e.stopPropagation()}>
        {/* Header */}
        <div className="modal-header">
          <div className="modal-header-left">
            <h2 className="modal-title">
              {request.type === 'upload' ? '📤 Upload Request' : '📥 Download Request'}
            </h2>
            <StatusBadge status={request.request?.status} />
          </div>
          <button className="modal-close-btn" onClick={onClose}>✕</button>
        </div>

        {/* Scrollable body */}
        <div className="modal-body">
          {/* Request Info */}
          <div className="modal-card">
            <div className="modal-card-title">📋 Request Information</div>
            <div className="modal-card-rows">
              {renderRows([
                ['Request ID', request.request?.requestId],
                ['Type', request.type],
                ['Submitted', request.request?.createdAt ? new Date(request.request.createdAt).toLocaleString() : 'N/A'],
                ['Status', request.request?.status],
                ['Reviewer', request.request?.reviewerId || '—'],
              ])}
            </div>
          </div>

          {/* Dataset Metadata */}
          {request.type === 'upload' && (
            <div className="modal-card">
              <div className="modal-card-title">🗂 Dataset Metadata</div>
              <div className="modal-card-rows">
                {renderSection('Core', [
                  ['Title', metadata.title],
                  ['Description', metadata.description],
                  ['Category', metadata.category],
                  ['Version', metadata.version],
                  ['Keywords', metadata.keywords],
                ])}
                {renderSection('Ownership & Funding', [
                  ['Owner', metadata.owner_name_or_org],
                  ['Source', metadata.source],
                  ['Uploader', metadata.uploader_name],
                  ['Organization', metadata.uploader_org],
                  ['Funded By', metadata.funded_by],
                  ['Grant / Project ID', metadata.grant_or_project_id],
                  ['Partner Institutions', metadata.partner_institutions],
                  ['Related Project URL', metadata.related_project_url],
                ])}
                {renderSection('Access & Compliance', [
                  ['License', metadata.license],
                  ['Access Level', metadata.access_level],
                  ['Allowed Users/Teams', metadata.allowed_users_or_teams],
                  ['Contains Sensitive Data', metadata.contains_sensitive_data],
                  ['Sensitive Types', metadata.sensitive_data_type],
                  ['Ethics / IRB', metadata.ethics_irb_reference],
                  ['Contact Email', metadata.contact_email],
                  ['Embargo Until', metadata.embargo_until],
                ])}
                {renderSection('Terms', [
                  ['T&C Accepted', metadata.terms_and_conditions_accept],
                  ['Rights Confirmed', metadata.rights_confirmation_accept],
                  ['Privacy Confirmed', metadata.privacy_compliance_accept],
                  ['Terms Version', metadata.terms_version_accepted],
                ])}

              </div>
            </div>
          )}

          {request.type === 'download' && (
            <div className="modal-card">
              <div className="modal-card-title">👤 Requester Info</div>
              <div className="modal-card-rows">
                {renderRows(
                  Object.entries(metadata).map(([k, v]) => [
                    k.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()),
                    v
                  ]).slice(0, 12)
                )}
              </div>
            </div>
          )}

          {/* Admin Actions */}
          <div className="modal-card modal-actions-card">
            <div className="modal-card-title">🛠 Admin Actions</div>

            {showRejectForm ? (
              <>
                <textarea
                  className="reject-reason-area"
                  placeholder="Rejection reason (required)..."
                  value={rejectionReason}
                  onChange={e => setRejectionReason(e.target.value)}
                  required
                />
                <div className="admin-action-buttons">
                  <button
                    className="row-btn-reject"
                    onClick={() => {
                      if (!rejectionReason.trim()) { alert('Please provide a rejection reason.'); return; }
                      if (window.confirm('Reject this request?'))
                        onReject(request.request.requestId, request.type, rejectionReason, '');
                    }}
                  >
                    Confirm Rejection
                  </button>
                  <button className="row-btn-view" onClick={() => setShowRejectForm(false)}>Cancel</button>
                </div>
              </>
            ) : (
              <div className="admin-action-buttons">
                <button
                  className="row-btn-approve"
                  disabled={isApproving}
                  onClick={() => {
                    if (!window.confirm('Approve this request?')) return;
                    if (!window.confirm('Please confirm approval one more time.')) return;
                    onApprove(request.request.requestId, request.type, '');
                  }}
                >
                  {isApproving ? 'Approving...' : '✓ Approve'}
                </button>
                <button className="row-btn-reject" onClick={() => setShowRejectForm(true)} disabled={isApproving}>✗ Reject</button>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// User Management tab
// ─────────────────────────────────────────────────────────────────────────────
function UserManagementTab() {
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [actionLoading, setActionLoading] = useState(null);
  const [searchTerm, setSearchTerm] = useState('');

  useEffect(() => { loadUsers(); }, []);

  const loadUsers = async () => {
    setLoading(true);
    setError('');
    try {
      const res = await getAdminUsers();
      if (res.success) setUsers(res.users);
    } catch {
      setError('Failed to load users.');
    } finally {
      setLoading(false);
    }
  };

  const handleToggleAdmin = async (user) => {
    const newIsAdmin = !user.isAdmin;
    const action = newIsAdmin ? 'promote to Admin' : 'remove Admin from';
    if (!window.confirm(`Are you sure you want to ${action} ${user.email}?`)) return;

    setActionLoading(user.email);
    try {
      const res = await setAdminUser(encodeURIComponent(user.email), newIsAdmin);
      if (res.success) {
        setUsers(prev => prev.map(u => u.email === user.email ? { ...u, isAdmin: newIsAdmin } : u));
      }
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to update admin status.');
    } finally {
      setActionLoading(null);
    }
  };

  const handleDelete = async (user) => {
    if (!window.confirm(`Permanently delete user ${user.email}?\n\nThis will remove them from Cognito and cannot be undone.`)) return;

    setActionLoading(user.email);
    try {
      const res = await deleteAdminUser(encodeURIComponent(user.email));
      if (res.success) {
        setUsers(prev => prev.filter(u => u.email !== user.email));
      }
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to delete user.');
    } finally {
      setActionLoading(null);
    }
  };

  if (loading) {
    return (
      <div className="admin-empty">
        <div className="spinner" style={{ borderTopColor: '#2a7c6f' }} />
        <p>Loading users...</p>
      </div>
    );
  }

  return (
    <div>
      <div className="admin-main-header">
        <h1 className="admin-main-title">User Management</h1>
        <div className="admin-actions-row">
          <input
            className="admin-search"
            placeholder="Search name, email, organization..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
          />
          <button className="admin-refresh-btn" onClick={loadUsers}>↻ Refresh</button>
        </div>
      </div>

      {error && <div className="admin-alert">{error}</div>}

      <div className="requests-table-wrap">
        {users.length === 0 ? (
          <div className="admin-empty">
            <span className="admin-empty-icon">👤</span>
            <p>No registered users found.</p>
          </div>
        ) : (
          (() => {
            const term = searchTerm.trim().toLowerCase();
            const filtered = term
              ? users.filter((u) =>
                  [u.name, u.email, u.organization, u.role].some((field) =>
                    String(field || '').toLowerCase().includes(term)
                  )
                )
              : users;
            const admins = filtered.filter((u) => u.isAdmin);
            const regular = filtered.filter((u) => !u.isAdmin);

            const renderTable = (rows) => (
              <table className="requests-table">
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Email</th>
                    <th>Organization</th>
                    <th>Role</th>
                    <th>Status</th>
                    <th>Joined</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map(user => {
                    const busy = actionLoading === user.email;
                    return (
                      <tr key={user.userId || user.email}>
                        <td style={{ fontWeight: 600, color: '#111827' }}>{user.name || '—'}</td>
                        <td style={{ color: '#374151' }}>{user.email}</td>
                        <td>{user.organization || '—'}</td>
                        <td>{user.role || '—'}</td>
                        <td><RoleBadge isAdmin={user.isAdmin} /></td>
                        <td>{user.createdAt ? new Date(user.createdAt).toLocaleDateString() : '—'}</td>
                        <td>
                          <div className="row-actions">
                            <button
                              className={user.isAdmin ? 'row-btn-reject' : 'row-btn-approve'}
                              onClick={() => handleToggleAdmin(user)}
                              disabled={busy}
                              title={user.isAdmin ? 'Remove admin' : 'Make admin'}
                            >
                              {busy ? '...' : user.isAdmin ? '↓ Remove Admin' : '↑ Make Admin'}
                            </button>
                            <button
                              className="row-btn-delete"
                              onClick={() => handleDelete(user)}
                              disabled={busy}
                              title="Delete user"
                            >
                              {busy ? '...' : '🗑 Delete'}
                            </button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            );

            return (
              <div className="admin-user-sections">
                <div className="admin-user-section">
                  <h2 className="admin-section-title">Admins</h2>
                  {admins.length ? renderTable(admins) : <div className="admin-empty compact">No admins found.</div>}
                </div>
                <div className="admin-user-section">
                  <h2 className="admin-section-title">Users</h2>
                  {regular.length ? renderTable(regular) : <div className="admin-empty compact">No users found.</div>}
                </div>
              </div>
            );
          })()
        )}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Request History tab
// ─────────────────────────────────────────────────────────────────────────────
function RequestHistoryTab() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [history, setHistory] = useState({ uploadRequests: [], downloadRequests: [] });

  const loadHistory = async () => {
    setLoading(true);
    setError('');
    try {
      const res = await getRequestHistory();
      if (res.success) {
        setHistory({
          uploadRequests: res.uploadRequests || [],
          downloadRequests: res.downloadRequests || [],
        });
      } else {
        setError('Failed to load history.');
      }
    } catch (err) {
      const status = err.response?.status;
      if (status === 404) {
        // History API not yet deployed — show friendly message, keep empty state
        setError('Request history is not yet available. It will appear once the latest backend is deployed.');
      } else {
        setError('Failed to load history. Please try again later.');
      }
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { loadHistory(); }, []);

  if (loading) {
    return (
      <div className="admin-empty">
        <div className="spinner" style={{ borderTopColor: '#2a7c6f' }} />
        <p>Loading request history...</p>
      </div>
    );
  }

  return (
    <div>
      <div className="admin-main-header">
        <h1 className="admin-main-title">Request History</h1>
        <button className="admin-refresh-btn" onClick={loadHistory}>↻ Refresh</button>
      </div>

      {error && <div className="admin-alert">{error}</div>}

      <div className="admin-user-sections">
        <div className="admin-user-section">
          <h2 className="admin-section-title">Upload Requests</h2>
          {history.uploadRequests.length === 0 ? (
            <div className="admin-empty compact">No upload requests yet.</div>
          ) : (
            <table className="requests-table">
              <thead>
                <tr>
                  <th>Title</th>
                  <th>Request ID</th>
                  <th>Status</th>
                  <th>Reviewer</th>
                  <th>Submitted</th>
                </tr>
              </thead>
              <tbody>
                {history.uploadRequests.map((req) => (
                  <tr key={req.requestId || req.request_id}>
                    <td>{req.metadata?.title || 'Untitled'}</td>
                    <td>{req.requestId || req.request_id}</td>
                    <td><StatusBadge status={req.status} /></td>
                    <td>{req.reviewerId || req.reviewer_id || '—'}</td>
                    <td>{req.createdAt ? new Date(req.createdAt).toLocaleDateString() : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        <div className="admin-user-section">
          <h2 className="admin-section-title">Download Requests</h2>
          {history.downloadRequests.length === 0 ? (
            <div className="admin-empty compact">No download requests yet.</div>
          ) : (
            <table className="requests-table">
              <thead>
                <tr>
                  <th>Dataset</th>
                  <th>Request ID</th>
                  <th>Status</th>
                  <th>Reviewer</th>
                  <th>Submitted</th>
                </tr>
              </thead>
              <tbody>
                {history.downloadRequests.map((req) => (
                  <tr key={req.requestId || req.request_id}>
                    <td>{req.datasetTitle || req.dataset_title || req.datasetId || req.dataset_id || '—'}</td>
                    <td>{req.requestId || req.request_id}</td>
                    <td><StatusBadge status={req.status} /></td>
                    <td>{req.reviewerId || req.reviewer_id || '—'}</td>
                    <td>{req.createdAt ? new Date(req.createdAt).toLocaleDateString() : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Main AdminDashboard
// ─────────────────────────────────────────────────────────────────────────────
function AdminDashboard() {
  const [activeTab, setActiveTab] = useState('upload');
  const [uploadRequests, setUploadRequests] = useState([]);
  const [downloadRequests, setDownloadRequests] = useState([]);
  const [selectedRequest, setSelectedRequest] = useState(null);
  const [activeChat, setActiveChat] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [approvingIds, setApprovingIds] = useState(new Set());

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (activeTab === 'upload' || activeTab === 'download') loadRequests();
  }, [activeTab]);

  const loadRequests = async () => {
    setLoading(true);
    setError('');
    try {
      const [uploadRes, downloadRes] = await Promise.all([
        getUploadRequests(),
        getDownloadRequests(),
      ]);
      if (uploadRes.success) setUploadRequests(uploadRes.requests);
      if (downloadRes.success) setDownloadRequests(downloadRes.requests);

      const uploadList = uploadRes.requests || [];
      const downloadList = downloadRes.requests || [];
      const messageCount = [...uploadList, ...downloadList].filter((req) => {
        const last = req.lastMessage || req.last_message;
        return last && last.sender !== 'admin';
      }).length;
      const requestCount = uploadList.filter((req) => ['pending', 'clarification_needed'].includes(req.status)).length
        + downloadList.filter((req) => ['pending', 'clarification_needed'].includes(req.status)).length;

      localStorage.setItem('notificationMessagesCount', String(messageCount));
      localStorage.setItem('notificationRequestsCount', String(requestCount));
      window.dispatchEvent(new Event('notification-changed'));
    } catch {
      setError('Failed to load requests. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  const handleViewRequest = async (requestId, type) => {
    try {
      const res = type === 'upload'
        ? await getUploadRequest(requestId)
        : await getDownloadRequest(requestId);
      if (res.success) setSelectedRequest({ ...res, type });
    } catch {
      setError('Failed to load request details.');
    }
  };

  const handleApprove = async (requestId, type, adminNotes = '') => {
    setApprovingIds((prev) => new Set(prev).add(requestId));
    try {
      if (type === 'upload') {
        const res = await approveUploadRequest(requestId, adminNotes);
        if (res?.pipeline?.started) {
          setError('');
          window.alert('Approved. Vaidio analysis pipeline started on the sample dataset.');
        } else if (res?.pipeline?.error) {
          window.alert(
            `Approved, but the analysis pipeline did not start: ${res.pipeline.error}. `
            + 'You can start it from the dataset page or check STEP_FUNCTIONS_STATE_MACHINE_ARN on the API.'
          );
        }
      } else {
        await approveDownloadRequest(requestId, adminNotes);
      }
      setSelectedRequest(null);
      loadRequests();
    } catch {
      setError('Failed to approve request.');
    } finally {
      setApprovingIds((prev) => {
        const next = new Set(prev);
        next.delete(requestId);
        return next;
      });
    }
  };

  const handleReject = async (requestId, type, reason, adminNotes = '') => {
    try {
      if (type === 'upload') await rejectUploadRequest(requestId, reason, adminNotes);
      else await rejectDownloadRequest(requestId, reason, adminNotes);
      setSelectedRequest(null);
      loadRequests();
    } catch {
      setError('Failed to reject request.');
    }
  };

  const handleClarify = async (requestId, type, adminNotes = '', isSilent = false) => {
    try {
      // If it's silent, we already appended the message, we just reload so status updates.
      if (!isSilent) {
        if (type === 'upload') await clarifyUploadRequest(requestId, adminNotes);
        else await clarifyDownloadRequest(requestId, adminNotes);
      }
      // Do not close the modal if silent (just updating thread)
      if (!isSilent) setSelectedRequest(null);
      loadRequests();
    } catch {
      setError('Failed to refresh or send clarification.');
    }
  };

  const list = activeTab === 'upload' ? uploadRequests : downloadRequests;
  const hasNewMessage = (req) => {
    const last = req.lastMessage;
    if (!last) return false;
    return last.sender !== 'admin';
  };

  const getTitle = (req) => {
    if (activeTab === 'upload') return req.stagingData?.metadata?.title || req.metadata?.title || 'Untitled Dataset';
    return (
      req.dataset?.title ||
      req.dataset_title ||
      (req.datasetId || req.dataset_id
        ? `Dataset ${String(req.datasetId || req.dataset_id).slice(0, 8)}…`
        : 'Unknown Dataset')
    );
  };

  const getSubmitter = (req) => {
    if (activeTab === 'upload') {
      return (
        req.stagingData?.metadata?.uploader_name ||
        req.stagingData?.metadata?.uploaderName ||
        req.metadata?.uploader_name ||
        req.metadata?.uploaderName ||
        '—'
      );
    }
    return (
      req.downloaderMetadata?.downloaderName ||
      req.downloaderMetadata?.downloader_name ||
      req.downloaderName ||
      req.downloader_name ||
      req.downloaderEmail ||
      req.downloader_email ||
      '—'
    );
  };

  return (
    <div className="admin-page">
      {/* Modal popup */}
      {selectedRequest && (
        <RequestModal
          request={selectedRequest}
          onClose={() => setSelectedRequest(null)}
          onApprove={handleApprove}
          onReject={handleReject}
          onClarify={handleClarify}
          isApproving={approvingIds.has(selectedRequest.request?.requestId)}
        />
      )}

      {/* Sidebar */}
      <aside className="admin-sidebar">
        <div className="admin-sidebar-title">Admin Panel</div>
        {NAV_TABS.map(tab => (
          <button
            key={tab.id}
            className={`admin-nav-item ${activeTab === tab.id ? 'active' : ''}`}
            onClick={() => { setSelectedRequest(null); setActiveTab(tab.id); }}
          >
            {tab.label}
            {(tab.id === 'upload' || tab.id === 'download') && (
              <span className="admin-nav-badge">
                {tab.id === 'upload' ? uploadRequests.length : downloadRequests.length}
              </span>
            )}
          </button>
        ))}
      </aside>

      {/* Extracted Admin Chat Panel */}
      {activeChat && (
        <AdminChatPanel
          type={activeChat.type}
          requestId={activeChat.requestId}
          onClose={() => setActiveChat(null)}
          onThreadUpdated={loadRequests}
        />
      )}

      {/* Main */}
      {activeChat ? null : activeTab === 'users' ? (
        <main className="admin-main">
          <UserManagementTab />
        </main>
      ) : activeTab === 'history' ? (
        <main className="admin-main">
          <RequestHistoryTab />
        </main>
      ) : (
        <main className="admin-main">
          <div className="admin-main-header">
            <h1 className="admin-main-title">
              {activeTab === 'upload' ? 'Upload Requests' : 'Download Requests'}
            </h1>
            <button className="admin-refresh-btn" onClick={loadRequests}>↻ Refresh</button>
          </div>

          {error && <div className="admin-alert">{error}</div>}

          <div className="requests-table-wrap">
            {loading ? (
              <div className="admin-empty">
                <div className="spinner" style={{ borderTopColor: '#2a7c6f' }} />
                <p>Loading...</p>
              </div>
            ) : list.length === 0 ? (
              <div className="admin-empty">
                <span className="admin-empty-icon">📭</span>
                <p>No {activeTab} requests found.</p>
              </div>
            ) : (
              <table className="requests-table">
                <thead>
                  <tr>
                    <th>Dataset</th>
                    <th>Submitted By</th>
                    <th>Date</th>
                    <th>Status</th>
                    <th>Reviewer</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {list.map(req => (
                    <tr key={req.requestId}>
                      <td style={{ fontWeight: 600, color: '#111827' }}>{getTitle(req)}</td>
                      <td>{getSubmitter(req)}</td>
                      <td>{new Date(req.createdAt).toLocaleDateString()}</td>
                      <td><StatusBadge status={req.status} /></td>
                      <td>{req.reviewerId || req.reviewer_id || '—'}</td>
                      <td>
                        <div className="row-actions">
                          {hasNewMessage(req) && (
                            <span className="message-pill">New message</span>
                          )}
                          <button
                            className="row-btn-view"
                            onClick={() => handleViewRequest(req.requestId, activeTab)}
                            title="View full details"
                          >
                            View More
                          </button>
                          {activeTab === 'upload' && (req.stagingData?.hasSample || req.metadata?.hasSample) && (
                            <button
                              className="row-btn-view"
                              style={{ marginLeft: '6px' }}
                              onClick={() => downloadAdminSample(req.requestId)}
                              title="Download Sample"
                            >
                              ⬇ Sample
                            </button>
                          )}
                          <button
                            className="row-btn-view"
                            style={{ marginLeft: '6px' }}
                            onClick={() => setActiveChat({ type: activeTab, requestId: req.requestId })}
                            title="Discussion Thread"
                          >
                            💬 Discussion
                          </button>
                          {req.status === 'pending' && (
                            <>
                              <button
                                className="row-btn-approve"
                                onClick={() => {
                                  if (!window.confirm('Approve this request?')) return;
                                  if (!window.confirm('Please confirm approval one more time.')) return;
                                  handleApprove(req.requestId, activeTab);
                                }}
                              >
                                Approve
                              </button>
                              <button className="row-btn-reject" onClick={() => handleViewRequest(req.requestId, activeTab)}>
                                Reject
                              </button>
                            </>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </main>
      )}
    </div>
  );
}

export default AdminDashboard;
