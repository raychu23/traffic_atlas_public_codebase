import React from 'react';
import './DatasetAnalysisTags.css';

const FIELD_ORDER = [
  'traffic_density',
  'weather',
  'lighting',
  'road_type',
  'vehicle_presence',
  'pedestrian_presence',
  'cyclist_presence',
  'truck_presence',
  'bus_presence',
  'motorcycle_presence',
  'emergency_vehicle_presence',
];

function formatFieldLabel(field) {
  return String(field || '')
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function formatValueLabel(value) {
  const text = String(value || 'unknown').replace(/_/g, ' ');
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function orderedDominantTags(dominantTags) {
  if (!dominantTags || typeof dominantTags !== 'object') return [];
  const entries = Object.entries(dominantTags).filter(([, v]) => v && v !== 'unknown');
  const rank = new Map(FIELD_ORDER.map((f, i) => [f, i]));
  return entries.sort(([a], [b]) => {
    const ra = rank.has(a) ? rank.get(a) : 999;
    const rb = rank.has(b) ? rank.get(b) : 999;
    return ra - rb || a.localeCompare(b);
  });
}

function DatasetAnalysisTags({ data }) {
  if (!data) return null;

  const rows = orderedDominantTags(data.dominant_tags);
  const filterList = Array.isArray(data.filter_tags) ? data.filter_tags : [];

  if (!rows.length && !filterList.length) return null;

  return (
    <div className="detail-dataset-tags" aria-labelledby="generated-tags-heading">
      <h3 id="generated-tags-heading" className="detail-dataset-tags-heading">
        Generated Tags
      </h3>
      {rows.length > 0 ? (
        <dl className="detail-dataset-tags-grid">
          {rows.map(([field, value]) => (
            <div key={field} className="detail-dataset-tag-row">
              <dt>{formatFieldLabel(field)}</dt>
              <dd>
                <span className="detail-dataset-tag-value">{formatValueLabel(value)}</span>
              </dd>
            </div>
          ))}
        </dl>
      ) : (
        <ul className="detail-dataset-tags-chips">
          {filterList.map((tag) => {
            const [field, value] = String(tag).split('.');
            return (
              <li key={tag} className="detail-dataset-tag-chip">
                <span className="detail-dataset-tag-chip-field">{formatFieldLabel(field)}</span>
                <span className="detail-dataset-tag-chip-value">{formatValueLabel(value)}</span>
              </li>
            );
          })}
        </ul>
      )}
      <p className="detail-dataset-tags-footnote">
        <span className="detail-dataset-tags-footnote-star" aria-hidden="true">*</span>
        AI-generated tags derived from traffic scene analysis using Claude 3.5 Haiku.
      </p>
    </div>
  );
}

export default DatasetAnalysisTags;
