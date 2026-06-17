import React, { useState, useEffect, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { getDatasets, getDatasetFilterTags } from "../services/api";
import "./DatasetDiscovery.css";

const MOCK_DATASETS = [];

const SORT_OPTIONS = [
  { value: "newest", label: "Newest first" },
  { value: "oldest", label: "Oldest first" },
];

function getAccessMode(dataset) {
  if (dataset.access_level === "Public") return "open";
  if (
    dataset.access_level === "Private" ||
    dataset.access_level === "Restricted"
  )
    return "request";
  return dataset.access_preference === "open" ? "open" : "request";
}

function normalizeKeywordList(keywords) {
  if (!keywords) return [];
  if (Array.isArray(keywords)) {
    return keywords
      .flatMap((item) => String(item).split(","))
      .map((tag) => tag.trim())
      .filter(Boolean);
  }
  return String(keywords)
    .split(",")
    .map((tag) => tag.trim())
    .filter(Boolean);
}

function formatFieldLabel(field) {
  return String(field || "")
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function formatValueLabel(value) {
  const text = String(value || "").replace(/_/g, " ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function formatFilterTagLabel(tag) {
  const [field, value] = String(tag).split(".");
  if (!value) {
    return formatFieldLabel(field);
  }
  return `${formatFieldLabel(field)}: ${formatValueLabel(value)}`;
}

function getDatasetFilterTagsList(dataset, datasetTagsMap) {
  const tags = datasetTagsMap[dataset.dataset_id];
  if (Array.isArray(tags) && tags.length > 0) {
    return tags;
  }
  return normalizeKeywordList(dataset.keywords);
}

function DatasetListItem({
  dataset,
  onClick,
  onDownloadSample,
  onRequestFull,
  onDownloadFull,
  onTagClick,
  datasetTags,
}) {
  const tags =
    datasetTags?.length > 0
      ? datasetTags.slice(0, 3)
      : normalizeKeywordList(dataset.keywords).slice(0, 3);
  const accessMode = getAccessMode(dataset);

  return (
    <div className="ds-list-item">
      <div className="ds-item-main" onClick={onClick}>
        <div className="ds-item-header">
          <h3 className="ds-item-title">{dataset.title}</h3>
          {dataset.status === "pending_full_upload" && (
            <span className="status-badge-small warning">Data Pending</span>
          )}
          {dataset.status === "pending_approval" && (
            <span className="status-badge-small info">Under Review</span>
          )}
        </div>

        <p className="ds-item-desc">
          {dataset.description?.substring(0, 180)}
          {dataset.description?.length > 180 ? "…" : ""}
        </p>

        <div className="ds-item-tags">
          <span
            className={`access-badge-small ${accessMode === "open" ? "open" : "request"}`}
          >
            {accessMode === "open" ? "Open Access" : "Request Based"}
          </span>
          {tags.map((t, i) => (
            <button
              key={i}
              type="button"
              className="ds-tag ds-tag-button"
              onClick={(e) => {
                e.stopPropagation();
                if (onTagClick) onTagClick(t);
              }}
            >
              {formatFilterTagLabel(t)}
            </button>
          ))}
          {dataset.location && (
            <span className="ds-tag loc">📍 {dataset.location}</span>
          )}
        </div>
      </div>

      <div className="ds-item-actions">
        <button
          className="ds-btn-outline"
          onClick={(e) => {
            e.stopPropagation();
            onDownloadSample();
          }}
        >
          Download Sample
        </button>
        {accessMode === "open" ? (
          <button
            className="ds-btn-primary"
            onClick={(e) => {
              e.stopPropagation();
              onDownloadFull();
            }}
            disabled={dataset.status === "pending_full_upload"}
            title={
              dataset.status === "pending_full_upload"
                ? "Full dataset not yet available"
                : undefined
            }
          >
            {dataset.status === "pending_full_upload"
              ? "Data Pending"
              : "Download Full Dataset"}
          </button>
        ) : (
          <button
            className="ds-btn-primary"
            onClick={(e) => {
              e.stopPropagation();
              onRequestFull();
            }}
          >
            Request Full Dataset
          </button>
        )}
      </div>
    </div>
  );
}

function DatasetDiscovery() {
  const navigate = useNavigate();
  const [datasets, setDatasets] = useState([]);
  const [datasetTagsMap, setDatasetTagsMap] = useState({});
  const [searchTerm, setSearchTerm] = useState("");
  const [filterSearchTerm, setFilterSearchTerm] = useState("");
  const [selectedTags, setSelectedTags] = useState([]);
  const [loading, setLoading] = useState(true);
  const [tagLoading, setTagLoading] = useState(false);
  const [sortOrder, setSortOrder] = useState("newest");

  const availableTags = useMemo(() => {
    const counts = new Map();

    datasets.forEach((dataset) => {
      const tags = new Set(getDatasetFilterTagsList(dataset, datasetTagsMap));
      tags.forEach((tag) => {
        if (!tag) return;
        counts.set(tag, (counts.get(tag) || 0) + 1);
      });
    });

    return Array.from(counts.entries())
      .map(([tag, count]) => {
        const [field, value] = String(tag).split(".");
        return {
          tag,
          count,
          field: field || "Other",
          value: value || "",
          label: formatFilterTagLabel(tag),
        };
      })
      .sort((a, b) => {
        if (a.field !== b.field) return a.field.localeCompare(b.field);
        if (a.value !== b.value) return a.value.localeCompare(b.value);
        return a.label.localeCompare(b.label);
      });
  }, [datasets, datasetTagsMap]);

  const visibleFilterOptions = useMemo(() => {
    const normalizedSearch = filterSearchTerm.trim().toLowerCase();
    return availableTags.filter(({ label, tag }) => {
      if (!normalizedSearch) return true;
      return (
        label.toLowerCase().includes(normalizedSearch) ||
        tag.toLowerCase().includes(normalizedSearch)
      );
    });
  }, [availableTags, filterSearchTerm]);

  const groupedFilterOptions = useMemo(() => {
    const groups = {};
    visibleFilterOptions.forEach((option) => {
      if (!groups[option.field]) groups[option.field] = [];
      groups[option.field].push(option);
    });
    return groups;
  }, [visibleFilterOptions]);

  const displayedDatasets = useMemo(() => {
    return datasets
      .filter((dataset) => {
        const normalizedSearch = searchTerm?.trim().toLowerCase();
        const datasetTags = getDatasetFilterTagsList(
          dataset,
          datasetTagsMap,
        ).map((tag) => tag.toLowerCase());
        const keywordText = normalizeKeywordList(dataset.keywords).join(", ");

        if (normalizedSearch) {
          const matchesSearch =
            String(dataset.title || "")
              .toLowerCase()
              .includes(normalizedSearch) ||
            String(dataset.description || "")
              .toLowerCase()
              .includes(normalizedSearch) ||
            keywordText.toLowerCase().includes(normalizedSearch) ||
            String(dataset.location || "")
              .toLowerCase()
              .includes(normalizedSearch);
          if (!matchesSearch) {
            return false;
          }
        }

        if (selectedTags.length > 0) {
          const matchAllSelected = selectedTags.every((tag) =>
            datasetTags.includes(tag.toLowerCase()),
          );
          if (!matchAllSelected) return false;
        }

        return true;
      })
      .sort((a, b) => {
        const aDate = new Date(
          a.createdAt || a.date_created || a.upload_timestamp || 0,
        ).getTime();
        const bDate = new Date(
          b.createdAt || b.date_created || b.upload_timestamp || 0,
        ).getTime();
        return sortOrder === "oldest" ? aDate - bDate : bDate - aDate;
      });
  }, [datasets, searchTerm, selectedTags, sortOrder, datasetTagsMap]);

  const toggleTag = (tag) => {
    setSelectedTags((prevTags) =>
      prevTags.includes(tag)
        ? prevTags.filter((existing) => existing !== tag)
        : [...prevTags, tag],
    );
  };

  const clearTagFilters = () => setSelectedTags([]);

  const loadDatasets = async (filters = {}) => {
    setLoading(true);
    try {
      const response = await getDatasets(filters);
      if (response.success && response.datasets?.length > 0) {
        setDatasets(
          response.datasets.map((d) => ({
            ...d,
            rating: Math.floor(Math.random() * 2) + 3,
          })),
        );
      } else {
        setDatasets(MOCK_DATASETS);
      }
    } catch {
      setDatasets(MOCK_DATASETS);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadDatasets();
  }, []);

  useEffect(() => {
    if (!datasets.length) {
      setDatasetTagsMap({});
      return;
    }

    let cancelled = false;
    const loadTags = async () => {
      setTagLoading(true);
      const updated = {};
      await Promise.all(
        datasets.map(async (dataset) => {
          try {
            const response = await getDatasetFilterTags(dataset.dataset_id);
            if (response.success && Array.isArray(response.filter_tags)) {
              updated[dataset.dataset_id] = response.filter_tags;
              return;
            }
          } catch (err) {
            // ignore missing/failed tags
          }
          updated[dataset.dataset_id] = [];
        }),
      );
      if (!cancelled) {
        setDatasetTagsMap(updated);
        setTagLoading(false);
      }
    };

    loadTags();
    return () => {
      cancelled = true;
    };
  }, [datasets]);

  const handleSearch = (e) => {
    e.preventDefault();
    loadDatasets({ search: searchTerm });
  };

  return (
    <div className="discovery-container">
      <div className="discovery-hero">
        <div className="hero-overlay"></div>
        <div className="hero-content">
          <h1>DATASETS</h1>
          <form onSubmit={handleSearch} className="hero-search-form">
            <div className="search-input-wrap">
              <span className="search-icon">🔍</span>
              <input
                type="text"
                placeholder="Search datasets by title, keywords, location..."
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
              />
            </div>
            <button type="submit">Search</button>
          </form>
        </div>
      </div>

      <div className="discovery-layout">
        <aside className="discovery-sidebar">
          <div className="filters-panel">
            <div className="filters-panel-header">
              <h2>Dataset Filters</h2>
              {tagLoading && (
                <span className="filter-loading">Loading tags…</span>
              )}
            </div>
            <div className="filter-search-wrap">
              <input
                type="text"
                placeholder="Search filters..."
                value={filterSearchTerm}
                onChange={(e) => setFilterSearchTerm(e.target.value)}
              />
            </div>
            <div className="selected-filters-summary">
              {selectedTags.length > 0 ? (
                <>
                  <span>
                    {selectedTags.length} filter
                    {selectedTags.length > 1 ? "s" : ""} selected
                  </span>
                  <button
                    type="button"
                    className="clear-tags-btn"
                    onClick={clearTagFilters}
                  >
                    Clear all
                  </button>
                </>
              ) : (
                <span>Pick tags to narrow datasets.</span>
              )}
            </div>
            <div className="filter-group-list">
              {Object.entries(groupedFilterOptions).map(([field, options]) => (
                <div key={field} className="filter-group">
                  <div className="filter-group-heading">
                    {formatFieldLabel(field)}
                  </div>
                  <div className="filter-group-options">
                    {options.map((option) => (
                      <label key={option.tag} className="filter-checkbox-label">
                        <input
                          type="checkbox"
                          checked={selectedTags.includes(option.tag)}
                          onChange={() => toggleTag(option.tag)}
                        />
                        <span>{option.label}</span>
                        <span className="filter-count">({option.count})</span>
                      </label>
                    ))}
                  </div>
                </div>
              ))}
              {availableTags.length === 0 && !tagLoading && (
                <p className="filter-empty">No generated tags available yet.</p>
              )}
            </div>
          </div>
        </aside>

        <main className="discovery-main">
          <div className="results-header">
            <p className="results-count">
              {loading
                ? "Loading..."
                : `${displayedDatasets.length} datasets found`}
            </p>
            <div className="results-sort">
              <span>Sort by</span>
              <select
                value={sortOrder}
                onChange={(e) => setSortOrder(e.target.value)}
              >
                {SORT_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {loading ? (
            <div className="discovery-loading">
              <div className="spinner" />
              <p>Loading datasets...</p>
            </div>
          ) : (
            <div className="ds-list">
              {displayedDatasets.map((dataset) => (
                <DatasetListItem
                  key={dataset.dataset_id}
                  dataset={dataset}
                  datasetTags={getDatasetFilterTagsList(
                    dataset,
                    datasetTagsMap,
                  )}
                  onClick={() => navigate(`/dataset/${dataset.dataset_id}`)}
                  onDownloadSample={() =>
                    navigate(`/dataset/${dataset.dataset_id}`)
                  }
                  onDownloadFull={() =>
                    navigate(`/download/${dataset.dataset_id}/metadata`)
                  }
                  onRequestFull={() =>
                    navigate(`/download/${dataset.dataset_id}/metadata`)
                  }
                  onTagClick={toggleTag}
                />
              ))}
              {displayedDatasets.length === 0 && (
                <div className="no-results">
                  <p>
                    No datasets match your search. Try adjusting your filters.
                  </p>
                  <button
                    className="primary-link-btn"
                    onClick={() => navigate("/upload")}
                  >
                    Upload a Dataset
                  </button>
                </div>
              )}
            </div>
          )}
        </main>
      </div>
    </div>
  );
}

export default DatasetDiscovery;
