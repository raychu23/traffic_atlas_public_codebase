import React, { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import {
  getUserDashboard,
  getMessages,
  sendMessage,
  getMyProfile,
  updateMyProfile,
  deleteMyProfile,
} from "../services/api";
import { clearAuthTokens, notifyAuthChanged } from "../services/authState";
import "./Profile.css";

const NAV_TABS = [
  { id: "upload", label: "My Dataset" },
  { id: "request-status", label: "Request Status" },
  { id: "account", label: "Account" },
];

const REQUEST_STATUS_TABS = [
  { id: "upload-requests", label: "Upload Requests" },
  { id: "download-requests", label: "Download Requests" },
];

function StatusBadge({ status, context = "upload" }) {
  let displayStatus = status || "Unknown";
  if (status === "clarification_needed") displayStatus = "Response Pending";
  if (context === "download") {
    if (status === "approved" || status === "active")
      displayStatus = "Access Granted";
  }

  return (
    <span
      className={`status-badge ${status?.toLowerCase().replace(/_/g, "-")}`}
    >
      {displayStatus}
    </span>
  );
}

// Dataset tile similar to Discover page
function DatasetTile({ dataset, onClick }) {
  const tags = Array.isArray(dataset.keywords)
    ? dataset.keywords.slice(0, 3)
    : dataset.keywords
      ? String(dataset.keywords).split(",").slice(0, 3)
      : [];
  const isOpen = dataset.access_level === "Public";

  return (
    <div className="profile-dataset-tile" onClick={onClick}>
      <div className="profile-tile-header">
        <h3 className="profile-tile-title">
          {dataset.title || "Untitled Dataset"}
        </h3>
        <span className={`access-badge-small ${isOpen ? "open" : "request"}`}>
          {isOpen ? "Open Access" : "Request Based"}
        </span>
      </div>
      <p className="profile-tile-desc">
        {dataset.description?.substring(0, 160)}
        {dataset.description?.length > 160 ? "…" : ""}
      </p>
      <div className="profile-tile-tags">
        {tags.map((t, i) => (
          <span key={i} className="ds-tag">
            {t.trim()}
          </span>
        ))}
        {dataset.location && (
          <span className="ds-tag loc">📍 {dataset.location}</span>
        )}
      </div>
      <div className="profile-tile-footer">
        <button className="ds-btn-primary" onClick={onClick}>
          View Dataset
        </button>
      </div>
    </div>
  );
}

// Full threaded Chat panel
function ChatPanel({ type, requestId, onClose, onThreadUpdated }) {
  const [messages, setMessages] = useState([]);
  const [newMessage, setNewMessage] = useState("");
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);

  useEffect(() => {
    let mounted = true;
    getMessages(type, requestId)
      .then((res) => {
        if (mounted && res.success) setMessages(res.messages || []);
        if (mounted) setLoading(false);
      })
      .catch(() => {
        if (mounted) setLoading(false);
      });
    return () => (mounted = false);
  }, [type, requestId]);

  const handleSend = async () => {
    if (!newMessage.trim()) return;
    setSending(true);
    try {
      const res = await sendMessage(type, requestId, newMessage);
      if (res.success && res.message) {
        setMessages((prev) => [...prev, res.message]);
        setNewMessage("");
        if (onThreadUpdated) onThreadUpdated();
      }
    } catch (e) {
      alert("Failed to send message");
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="clarify-overlay" onClick={onClose}>
      <div className="chat-panel" onClick={(e) => e.stopPropagation()}>
        <div className="chat-panel-header">
          <span>💬 Request Discussion</span>
          <button className="clarify-close-btn" onClick={onClose}>
            ✕
          </button>
        </div>

        <div className="chat-panel-messages">
          {loading ? (
            <div className="chat-loading">
              <div className="spinner sm"></div>
            </div>
          ) : messages.length === 0 ? (
            <div className="chat-empty">No messages yet.</div>
          ) : (
            messages.map((msg) => (
              <div
                key={msg.id}
                className={`chat-bubble ${msg.sender === "admin" ? "admin" : "user"}`}
              >
                <div className="chat-bubble-sender">{msg.senderLabel}</div>
                <div className="chat-bubble-text">{msg.text}</div>
                <div className="chat-bubble-time">
                  {new Date(msg.timestamp).toLocaleString()}
                </div>
              </div>
            ))
          )}
        </div>

        <div className="chat-panel-input">
          <textarea
            placeholder="Type your reply here..."
            value={newMessage}
            onChange={(e) => setNewMessage(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                handleSend();
              }
            }}
          />
          <button
            className="chat-send-btn"
            onClick={handleSend}
            disabled={sending || !newMessage.trim()}
          >
            {sending ? "..." : "Send"}
          </button>
        </div>
      </div>
    </div>
  );
}

function Profile() {
  const navigate = useNavigate();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");
  const [activeTab, setActiveTab] = useState("upload");
  const [requestStatusTab, setRequestStatusTab] = useState("upload-requests");
  const [activeChat, setActiveChat] = useState(null); // { type, requestId }
  const [accountForm, setAccountForm] = useState({
    name: localStorage.getItem("userName") || "",
    organization: localStorage.getItem("userOrganization") || "",
    role: localStorage.getItem("userRole") || "",
  });
  const [accountLoading, setAccountLoading] = useState(false);
  const [accountMessage, setAccountMessage] = useState("");

  useEffect(() => {
    const cached = localStorage.getItem("profileDashboardCache");
    if (cached) {
      try {
        setData(JSON.parse(cached));
        setLoading(false);
      } catch {
        // ignore cache parse failure
      }
    }
    loadDashboard(!cached);
    loadAccount();
  }, []);

  const loadAccount = async () => {
    try {
      const res = await getMyProfile();
      if (res.success && res.user) {
        setAccountForm({
          name: res.user.name || "",
          organization: res.user.organization || "",
          role: res.user.role || "",
        });
        localStorage.setItem("userName", res.user.name || "");
        localStorage.setItem("userOrganization", res.user.organization || "");
        localStorage.setItem("userRole", res.user.role || "");
        notifyAuthChanged();
      }
    } catch {
      // ignore profile load failures
    }
  };

  const handleAccountChange = (e) => {
    const { name, value } = e.target;
    setAccountForm((prev) => ({ ...prev, [name]: value }));
  };

  const handleAccountSave = async () => {
    setAccountLoading(true);
    setAccountMessage("");
    try {
      const res = await updateMyProfile({
        name: accountForm.name,
        organization: accountForm.organization,
        role: accountForm.role,
      });
      if (res.success && res.user) {
        localStorage.setItem("userName", res.user.name || "");
        localStorage.setItem("userOrganization", res.user.organization || "");
        localStorage.setItem("userRole", res.user.role || "");
        notifyAuthChanged();
        setAccountMessage("Profile updated successfully.");
      } else {
        setAccountMessage("Failed to update profile.");
      }
    } catch {
      setAccountMessage("Failed to update profile.");
    } finally {
      setAccountLoading(false);
    }
  };

  const handleAccountDelete = async () => {
    if (
      !window.confirm("Delete your profile and account? This cannot be undone.")
    )
      return;
    if (
      !window.confirm(
        "Please confirm once more to permanently delete your account.",
      )
    )
      return;
    setAccountLoading(true);
    setAccountMessage("");
    try {
      const res = await deleteMyProfile();
      if (res.success) {
        clearAuthTokens();
        notifyAuthChanged();
        window.location.href = "/login";
        return;
      }
      setAccountMessage("Failed to delete account.");
    } catch {
      setAccountMessage("Failed to delete account.");
    } finally {
      setAccountLoading(false);
    }
  };

  const loadDashboard = async (showSpinner = true) => {
    if (showSpinner) {
      setLoading(true);
    } else {
      setRefreshing(true);
    }
    try {
      const response = await getUserDashboard();
      if (response.success) {
        setData(response);
        localStorage.setItem("profileDashboardCache", JSON.stringify(response));
        const uploadRequests = response.upload_requests || [];
        const downloadRequests = response.download_requests || [];
        const messageCount = [...uploadRequests, ...downloadRequests].filter(
          (req) => {
            const last = req.last_message || req.lastMessage;
            return last && last.sender === "admin";
          },
        ).length;
        const requestCount =
          uploadRequests.filter((req) => req.status === "approved").length +
          downloadRequests.filter((req) => req.status === "approved").length;

        localStorage.setItem("notificationMessagesCount", String(messageCount));
        localStorage.setItem("notificationRequestsCount", String(requestCount));
        window.dispatchEvent(new Event("notification-changed"));
      } else {
        setError(response.error || "Failed to load dashboard");
      }
    } catch (err) {
      setError("Error connecting to server");
    } finally {
      if (showSpinner) {
        setLoading(false);
      } else {
        setRefreshing(false);
      }
    }
  };

  if (loading)
    return (
      <div className="profile-loading">
        <div className="spinner"></div>
        <p>Loading your profile...</p>
      </div>
    );
  if (error)
    return (
      <div className="profile-error">
        <p>{error}</p>
        <button onClick={loadDashboard}>Retry</button>
      </div>
    );

  // Show only fully active datasets in My Dataset tab
  const activeDatasets = (data.datasets || []).filter(
    (ds) => ds.status === "active",
  );

  return (
    <div className="admin-dashboard">
      {activeChat && (
        <ChatPanel
          type={activeChat.type}
          requestId={activeChat.requestId}
          onClose={() => setActiveChat(null)}
          onThreadUpdated={loadDashboard}
        />
      )}

      <div className="admin-sidebar">
        <div className="admin-sidebar-header">
          <h2>My Profile</h2>
        </div>
        <nav className="admin-nav">
          {NAV_TABS.map((tab) => (
            <button
              key={tab.id}
              className={`admin-nav-btn ${activeTab === tab.id ? "active" : ""}`}
              onClick={() => setActiveTab(tab.id)}
            >
              <span className="admin-nav-label">{tab.label}</span>
            </button>
          ))}
        </nav>
      </div>

      <div className="admin-main">
        {/* ── My Dataset Tab ── */}
        {activeTab === "upload" && (
          <div className="admin-content">
            <div className="admin-header">
              <h1>My Dataset</h1>
              <p>Your approved and fully uploaded datasets.</p>
              {refreshing && (
                <p className="refreshing-note">Refreshing data...</p>
              )}
            </div>
            {activeDatasets.length === 0 ? (
              <div className="profile-no-datasets">
                <span className="profile-no-icon">📂</span>
                <p>
                  No published datasets yet. Once your upload is approved and
                  completed, your datasets will appear here.
                </p>
                <button
                  className="ds-btn-primary"
                  onClick={() => navigate("/upload")}
                >
                  Upload a Dataset
                </button>
              </div>
            ) : (
              <div className="profile-dataset-grid">
                {activeDatasets.map((ds) => (
                  <DatasetTile
                    key={ds.dataset_id || ds.datasetId}
                    dataset={ds}
                    onClick={() =>
                      navigate(`/dataset/${ds.dataset_id || ds.datasetId}`)
                    }
                  />
                ))}
              </div>
            )}
          </div>
        )}

        {/* ── Account Tab ── */}
        {activeTab === "account" && (
          <div className="admin-content">
            <div className="admin-header">
              <h1>Account</h1>
              <p>Update your profile details or delete your account.</p>
            </div>

            <div className="account-card">
              <div className="account-form">
                <div className="account-row">
                  <div className="account-group">
                    <label htmlFor="accountName">Full Name</label>
                    <input
                      id="accountName"
                      name="name"
                      value={accountForm.name}
                      onChange={handleAccountChange}
                      placeholder="Your name"
                    />
                  </div>
                  <div className="account-group">
                    <label htmlFor="accountRole">Role</label>
                    <input
                      id="accountRole"
                      name="role"
                      value={accountForm.role}
                      onChange={handleAccountChange}
                      placeholder="Researcher, Student, etc."
                    />
                  </div>
                </div>
                <div className="account-group">
                  <label htmlFor="accountOrg">Organization</label>
                  <input
                    id="accountOrg"
                    name="organization"
                    value={accountForm.organization}
                    onChange={handleAccountChange}
                    placeholder="University or Organization"
                  />
                </div>
                {accountMessage && (
                  <div className="account-message">{accountMessage}</div>
                )}
                <div className="account-actions">
                  <button
                    className="ds-btn-primary"
                    onClick={handleAccountSave}
                    disabled={accountLoading}
                  >
                    {accountLoading ? "Saving..." : "Save Changes"}
                  </button>
                  <button
                    className="account-delete-btn"
                    onClick={handleAccountDelete}
                    disabled={accountLoading}
                  >
                    Delete Account
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* ── Request Status Tab ── */}
        {activeTab === "request-status" && (
          <div className="admin-content">
            <div className="admin-header profile-header-row">
              <div>
                <h1>Request Status</h1>
                <p>Track the status of your upload and download requests.</p>
              </div>
              <button className="profile-refresh-btn" onClick={loadDashboard}>
                ↻ Refresh
              </button>
            </div>

            {/* Sub-tabs */}
            <div className="sub-tabs">
              {REQUEST_STATUS_TABS.map((tab) => (
                <button
                  key={tab.id}
                  className={`sub-tab-btn ${requestStatusTab === tab.id ? "active" : ""}`}
                  onClick={() => setRequestStatusTab(tab.id)}
                >
                  <span className="sub-tab-label">{tab.label}</span>
                </button>
              ))}
            </div>

            {/* Upload Requests Sub-tab */}
            {requestStatusTab === "upload-requests" && (
              <div className="admin-table-container">
                <table className="admin-table">
                  <thead>
                    <tr>
                      <th>Dataset Title</th>
                      <th>Request ID</th>
                      <th>Date</th>
                      <th>Time Submitted</th>
                      <th>Status</th>
                      <th>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.upload_requests.length === 0 ? (
                      <tr>
                        <td colSpan="6" className="no-data">
                          You haven't submitted any datasets yet.
                        </td>
                      </tr>
                    ) : (
                      data.upload_requests.map((req) => {
                        const needsClarify =
                          req.status === "clarification_needed";
                        const dDate = new Date(req.created_at || req.createdAt);
                        return (
                          <tr key={req.request_id}>
                            <td>
                              <div className="dataset-title">
                                {req.metadata?.title || "Untitled Dataset"}
                              </div>
                            </td>
                            <td className="req-id">{req.request_id}</td>
                            <td>{dDate.toLocaleDateString()}</td>
                            <td>
                              {dDate.toLocaleTimeString([], {
                                hour: "2-digit",
                                minute: "2-digit",
                              })}
                            </td>
                            <td>
                              <StatusBadge status={req.status} />
                            </td>
                            <td>
                              <div className="admin-actions">
                                {req.reviewer_id && (
                                  <div className="reviewer-note">
                                    Reviewer: {req.reviewer_id}
                                  </div>
                                )}
                                {req.status === "active" && (
                                  <span
                                    style={{
                                      color: "#065f46",
                                      fontWeight: 600,
                                      fontSize: "0.85rem",
                                    }}
                                  >
                                    ✓ Already Uploaded
                                  </span>
                                )}
                                {req.status === "approved" && (
                                  <button
                                    className="admin-btn primary"
                                    onClick={() =>
                                      navigate(`/upload/full/${req.request_id}`)
                                    }
                                  >
                                    Upload Full Dataset
                                  </button>
                                )}
                                {(req.status === "pending" ||
                                  req.status === "clarification_needed" ||
                                  req.status === "approved" ||
                                  req.status === "rejected" ||
                                  req.status === "active") && (
                                  <button
                                    className={
                                      needsClarify
                                        ? "clarify-btn"
                                        : "chat-btn-secondary"
                                    }
                                    onClick={() =>
                                      setActiveChat({
                                        type: "upload",
                                        requestId: req.request_id,
                                      })
                                    }
                                  >
                                    {needsClarify
                                      ? "💬 Reply to Admin"
                                      : "💬 Discussion"}
                                  </button>
                                )}
                                {req.status === "rejected" &&
                                  (req.reason ||
                                    req.admin_notes ||
                                    req.rejection_reason) && (
                                    <div className="admin-feedback rejected">
                                      <div className="feedback-label">
                                        Admin's note:
                                      </div>
                                      <div className="feedback-comment">
                                        {req.reason ||
                                          req.admin_notes ||
                                          req.rejection_reason}
                                      </div>
                                    </div>
                                  )}
                                {req.status === "approved" &&
                                  req.admin_notes && (
                                    <div className="admin-feedback approved">
                                      <div className="feedback-comment">
                                        {req.admin_notes}
                                      </div>
                                    </div>
                                  )}
                              </div>
                            </td>
                          </tr>
                        );
                      })
                    )}
                  </tbody>
                </table>
              </div>
            )}

            {/* Download Requests Sub-tab */}
            {requestStatusTab === "download-requests" && (
              <div className="admin-table-container">
                <table className="admin-table">
                  <thead>
                    <tr>
                      <th>Dataset Title</th>
                      <th>Request ID</th>
                      <th>Date</th>
                      <th>Time Submitted</th>
                      <th>Status</th>
                      <th>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.download_requests.length === 0 ? (
                      <tr>
                        <td colSpan="6" className="no-data">
                          You haven't requested any datasets yet.
                        </td>
                      </tr>
                    ) : (
                      data.download_requests.map((req) => {
                        const dDate = new Date(req.created_at || req.createdAt);
                        return (
                          <tr key={req.request_id}>
                            <td>
                              <div className="dataset-title">
                                {req.dataset_title || req.dataset_id || "—"}
                              </div>
                            </td>
                            <td className="req-id">{req.request_id}</td>
                            <td>{dDate.toLocaleDateString()}</td>
                            <td>
                              {dDate.toLocaleTimeString([], {
                                hour: "2-digit",
                                minute: "2-digit",
                              })}
                            </td>
                            <td>
                              <StatusBadge
                                status={req.status}
                                context="download"
                              />
                            </td>
                            <td>
                              <div className="admin-actions">
                                {req.reviewer_id && (
                                  <div className="reviewer-note">
                                    Reviewer: {req.reviewer_id}
                                  </div>
                                )}
                                {req.status === "approved" && (
                                  <button
                                    className="admin-btn primary"
                                    onClick={() =>
                                      navigate(
                                        `/download/${req.dataset_id}/metadata`,
                                      )
                                    }
                                  >
                                    Download Full Dataset
                                  </button>
                                )}
                                {(req.status === "pending" ||
                                  req.status === "clarification_needed" ||
                                  req.status === "approved" ||
                                  req.status === "rejected" ||
                                  req.status === "active") && (
                                  <button
                                    className={
                                      req.status === "clarification_needed"
                                        ? "clarify-btn"
                                        : "chat-btn-secondary"
                                    }
                                    onClick={() =>
                                      setActiveChat({
                                        type: "download",
                                        requestId: req.request_id,
                                      })
                                    }
                                  >
                                    {req.status === "clarification_needed"
                                      ? "💬 Reply to Admin"
                                      : "💬 Discussion"}
                                  </button>
                                )}
                                {req.status === "rejected" &&
                                  (req.reason ||
                                    req.admin_notes ||
                                    req.rejection_reason) && (
                                    <div className="admin-feedback rejected">
                                      <div className="feedback-label">
                                        Admin's note:
                                      </div>
                                      <div className="feedback-comment">
                                        {req.reason ||
                                          req.admin_notes ||
                                          req.rejection_reason}
                                      </div>
                                    </div>
                                  )}
                                {req.status === "approved" &&
                                  req.admin_notes && (
                                    <div className="admin-feedback approved">
                                      <div className="feedback-comment">
                                        {req.admin_notes}
                                      </div>
                                    </div>
                                  )}
                              </div>
                            </td>
                          </tr>
                        );
                      })
                    )}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

export default Profile;
