# Metadata Architecture & Website Integration Guide

## Overview

The dataset processing pipeline generates metadata at three levels—frame, video, and dataset—which flows into the website's filter system.

```
Frame-Level Metadata (Detailed)
    ↓ Aggregation
Video-Level Summaries (Smoothed)
    ↓ Aggregation
Dataset-Level Summaries (Stable Filters)
    ↓
Website Filter UI
```

## Metadata Levels Explained

### Level 1: Frame-Level Metadata

**Purpose**: Maximum detail for advanced search/analysis

**Location**: `sample_analysis/metadata/frames/{video_name}/{frame_name}.json`

**Content**:
```json
{
  "tags": ["vehicle", "street", "urban", "parked"],
  "confidence_scores": [0.95, 0.92, 0.88, 0.85],
  "description": "City street with parked cars and traffic",
  "bedrock_raw": {
    "content": [{
      "type": "text",
      "text": "{\"tags\": [...], \"confidence_scores\": [...], \"description\": \"...\"}"
    }]
  },
  "processed_at": "2024-01-15T10:32:45Z"
}
```

**Usage**:
- Detailed content search
- Frame-by-frame browsing
- ML model evaluation/debugging
- Ground truth verification

**Retention**: Keep indefinitely (valuable for model improvement)

---

### Level 2: Video-Level Summaries

**Purpose**: Smooth out frame-level noise, provide per-video statistics

**Location**: `sample_analysis/metadata/videos/{video_name}.json`

**Content**:
```json
{
  "video_name": "traffic_scene_001",
  "frame_count": 150,
  "detected_tags": [
    "vehicle", "street", "urban", "parked", "person",
    "traffic", "building", "road", "car", "intersection"
  ],
  "tag_details": {
    "vehicle": {
      "count": 142,
      "avg_confidence": 0.94,
      "frequency_in_video": 142
    },
    "street": {
      "count": 148,
      "avg_confidence": 0.91,
      "frequency_in_video": 148
    },
    "person": {
      "count": 45,
      "avg_confidence": 0.78,
      "frequency_in_video": 45
    }
  },
  "coverage": 45,
  "processing_date": "2024-01-15T10:35:22Z"
}
```

**Key Fields**:
- `detected_tags`: All tags found in this video
- `tag_details`: Per-tag statistics with frequency and confidence
- `frequency_in_video`: How many frames contain this tag in this video
- `coverage`: Total unique tag count

**Aggregation Logic**:
- Derived by reading all frame-level metadata for the video
- Filters out low-confidence tags (optional: < 0.7)
- Calculates frequency across frames
- Computes average confidence per tag

**Usage**:
- Per-video search/filtering
- Video preview UI
- Dataset composition analysis

---

### Level 3: Dataset-Level Summaries

**Purpose**: Website filter UI, stable aggregated view

**Location**: `sample_analysis/metadata/dataset/`

Three files compose the dataset summary:

#### 3a. dataset_summary.json

Overall dataset statistics and dominant tags:

```json
{
  "dataset_id": "dataset_abc123",
  "summary_generated_at": "2024-01-15T10:40:15Z",
  "processing_summary": {
    "total_videos": 5,
    "total_frames_sampled": 750,
    "unique_tags_detected": 47
  },
  "dominant_tags": [
    {
      "tag": "vehicle",
      "occurrences": 680,
      "confidence": 0.94,
      "prevalence": 90.7
    },
    {
      "tag": "street",
      "occurrences": 720,
      "confidence": 0.91,
      "prevalence": 96.0
    },
    {
      "tag": "urban",
      "occurrences": 710,
      "confidence": 0.89,
      "prevalence": 94.7
    }
  ],
  "all_detected_tags": [
    "vehicle", "street", "urban", "parked", "person",
    "traffic", "building", "road", "car", "intersection",
    ...
  ],
  "tag_coverage": {
    "total_unique_tags": 47,
    "by_category": {
      "objects": 22,
      "activities": 14,
      "environment": 11
    }
  },
  "dataset_status": "processing_complete",
  "ready_for_web_display": true
}
```

**Usage**:
- Dataset overview card
- Top-level statistics in UI
- Decision logic for showing advanced filters

---

#### 3b. dataset_filter_tags.json

**THE MAIN FILE FOR WEBSITE FILTERS**

Hierarchical tags organized by category, optimized for UI filter bars:

```json
{
  "objects": {
    "vehicle": {
      "count": 680,
      "confidence": 0.94,
      "prevalence": 90.7,
      "clickable": true
    },
    "person": {
      "count": 230,
      "confidence": 0.87,
      "prevalence": 30.7,
      "clickable": true
    },
    "furniture": {
      "count": 12,
      "confidence": 0.45,
      "prevalence": 1.6,
      "clickable": false
    }
  },
  "activities": {
    "moving": {
      "count": 450,
      "confidence": 0.85,
      "prevalence": 60.0,
      "clickable": true
    },
    "stationary": {
      "count": 300,
      "confidence": 0.79,
      "prevalence": 40.0,
      "clickable": true
    }
  },
  "environment": {
    "urban": {
      "count": 720,
      "confidence": 0.91,
      "prevalence": 96.0,
      "clickable": true
    },
    "indoor": {
      "count": 5,
      "confidence": 0.30,
      "prevalence": 0.7,
      "clickable": false
    }
  },
  "other": {}
}
```

**Field Reference**:
- `count`: Total frame occurrences across entire dataset
- `confidence`: Average confidence score
- `prevalence`: Percentage of frames containing tag (0–100)
- `clickable`: Should this tag appear in website filters?
  - `true` if prevalence >= 5%
  - `false` if too rare or low confidence
- **Category keys**: `objects`, `activities`, `environment`, `other`

**Frontend Filter Logic**:

```javascript
// Load dataset filter tags
const filterData = await fetch(
  `s3://bucket/sample_data/{dataset_id}/sample_analysis/metadata/dataset/dataset_filter_tags.json`
).then(r => r.json());

// Build filter UI
for (const [category, tags] of Object.entries(filterData)) {
  if (Object.keys(tags).length === 0) continue; // Skip empty categories
  
  const filterGroup = document.createElement('div');
  filterGroup.className = 'filter-group';
  filterGroup.innerHTML = `<h3>${capitalizeCategory(category)}</h3>`;
  
  for (const [tagName, tagData] of Object.entries(tags)) {
    if (!tagData.clickable) continue; // Hide non-clickable tags
    
    const badge = document.createElement('button');
    badge.className = 'filter-badge';
    badge.innerHTML = `
      ${tagName}
      <span class="badge-count">${tagData.count}</span>
      <span class="badge-prevalence">${tagData.prevalence.toFixed(1)}%</span>
    `;
    badge.onclick = () => filterDatasetByTag(dataset_id, tagName);
    badge.style.opacity = Math.min(tagData.confidence, 1.0);
    
    filterGroup.appendChild(badge);
  }
  
  filtersContainer.appendChild(filterGroup);
}
```

---

#### 3c. dataset_tag_distribution.json

Detailed per-tag statistics across all videos:

```json
{
  "vehicle": {
    "total_occurrences": 680,
    "videos_with_tag": 5,
    "avg_confidence": 0.94,
    "prevalence_percentage": 90.7,
    "video_coverage": [
      "traffic_001",
      "traffic_002",
      "traffic_003",
      "traffic_005"
    ]
  },
  "person": {
    "total_occurrences": 230,
    "videos_with_tag": 3,
    "avg_confidence": 0.87,
    "prevalence_percentage": 30.7,
    "video_coverage": ["traffic_001", "traffic_003", "traffic_005"]
  },
  ...
}
```

**Usage**:
- Tag statistics/reports
- Data quality evaluation
- Filtering analysis (which videos have which tags)

---

## Aggregation Algorithm

### Frame → Video Aggregation

```python
def aggregate_frames_to_video(frames):
    """
    frames: list of frame metadata dicts
    """
    tag_stats = {}
    
    for frame in frames:
        for tag, confidence in zip(frame['tags'], frame['confidence_scores']):
            if tag not in tag_stats:
                tag_stats[tag] = {
                    'count': 0,
                    'confidences': [],
                    'frequency': 0
                }
            tag_stats[tag]['count'] += 1
            tag_stats[tag]['confidences'].append(confidence)
            tag_stats[tag]['frequency'] += 1
    
    # Convert to video summary format
    tag_details = {}
    for tag, stats in tag_stats.items():
        tag_details[tag] = {
            'count': stats['count'],
            'avg_confidence': sum(stats['confidences']) / len(stats['confidences']),
            'frequency_in_video': stats['frequency']
        }
    
    return {
        'detected_tags': list(tag_details.keys()),
        'tag_details': tag_details,
        'coverage': len(tag_details),
        'frame_count': len(frames)
    }
```

### Video → Dataset Aggregation

```python
def aggregate_videos_to_dataset(videos):
    """
    videos: list of video summary dicts
    """
    tag_stats = {}
    total_frames = sum(v['frame_count'] for v in videos)
    
    for video in videos:
        for tag, details in video['tag_details'].items():
            if tag not in tag_stats:
                tag_stats[tag] = {
                    'occurrences': 0,
                    'confidences': [],
                    'video_list': []
                }
            tag_stats[tag]['occurrences'] += details['frequency_in_video']
            tag_stats[tag]['confidences'].append(details['avg_confidence'])
            tag_stats[tag]['video_list'].append(video['video_name'])
    
    # Calculate dataset-level statistics
    filter_tags = {}
    for tag, stats in tag_stats.items():
        avg_confidence = sum(stats['confidences']) / len(stats['confidences'])
        prevalence = (stats['occurrences'] / total_frames) * 100
        clickable = prevalence >= 5.0 and avg_confidence >= 0.60
        
        # Categorize tag
        category = categorize_tag(tag)  # Returns 'objects', 'activities', etc.
        
        if category not in filter_tags:
            filter_tags[category] = {}
        
        filter_tags[category][tag] = {
            'count': stats['occurrences'],
            'confidence': round(avg_confidence, 3),
            'prevalence': round(prevalence, 1),
            'clickable': clickable
        }
    
    return filter_tags
```

---

## Website Filter Implementation

### Example React Component

```jsx
import React, { useState, useEffect } from 'react';
import s3 from './s3-client';

export function DatasetFilters({ datasetId, onFilterChange }) {
  const [filterTags, setFilterTags] = useState({});
  const [selectedTags, setSelectedTags] = useState(new Set());
  const [loading, setLoading] = useState(true);
  
  useEffect(() => {
    loadDatasetFilters();
  }, [datasetId]);
  
  async function loadDatasetFilters() {
    try {
      setLoading(true);
      const key = `sample_data/${datasetId}/sample_analysis/metadata/dataset/dataset_filter_tags.json`;
      const response = await s3.getObject({ Bucket, Key: key }).promise();
      const tags = JSON.parse(response.Body.toString('utf-8'));
      setFilterTags(tags);
    } catch (error) {
      console.error('Failed to load filters:', error);
    } finally {
      setLoading(false);
    }
  }
  
  function toggleTag(category, tag) {
    const newSelected = new Set(selectedTags);
    const key = `${category}:${tag}`;
    
    if (newSelected.has(key)) {
      newSelected.delete(key);
    } else {
      newSelected.add(key);
    }
    
    setSelectedTags(newSelected);
    onFilterChange(Array.from(newSelected));
  }
  
  if (loading) return <div>Loading filters...</div>;
  
  return (
    <div className="dataset-filters">
      {Object.entries(filterTags).map(([category, tags]) => (
        <div key={category} className="filter-group">
          <h3>{category.charAt(0).toUpperCase() + category.slice(1)}</h3>
          <div className="filter-tags">
            {Object.entries(tags)
              .filter(([_, data]) => data.clickable)
              .map(([tag, data]) => (
                <button
                  key={tag}
                  className={`filter-tag ${selectedTags.has(`${category}:${tag}`) ? 'active' : ''}`}
                  onClick={() => toggleTag(category, tag)}
                  title={`${data.count} frames (${data.prevalence}%)`}
                  style={{
                    opacity: Math.min(data.confidence, 1.0),
                    borderColor: `hsla(${data.prevalence * 3.6}, 70%, 50%, ${data.confidence})`
                  }}
                >
                  {tag}
                  <span className="tag-stats">
                    {data.count} • {data.prevalence.toFixed(1)}%
                  </span>
                </button>
              ))}
          </div>
        </div>
      ))}
    </div>
  );
}
```

---

## File Organization Reference

```
sample_data/{dataset_id}/
├── sample_analysis/
    ├── metadata/
    │   ├── dataset/
    │   │   ├── dataset_summary.json              ← Overview
    │   │   ├── dataset_filter_tags.json          ← PRIMARY FOR FILTERS ⭐
    │   │   └── dataset_tag_distribution.json     ← Detailed stats
    │   │
    │   ├── videos/
    │   │   ├── video_001.json                    ← Video aggregation
    │   │   ├── video_002.json
    │   │   └── ...
    │   │
    │   └── frames/
    │       ├── video_001/
    │       │   ├── frame_000001.json             ← Frame detail
    │       │   ├── frame_000002.json
    │       │   └── ...
    │       └── ...
    │
    └── ...
```

---

## Performance Tips

### Caching Strategy

```javascript
// Cache dataset filters (1 hour TTL)
const FILTER_CACHE_TTL = 3600 * 1000;

async function getCachedFilters(datasetId) {
  const cacheKey = `filters-${datasetId}`;
  const cached = localStorage.getItem(cacheKey);
  
  if (cached) {
    const { data, timestamp } = JSON.parse(cached);
    if (Date.now() - timestamp < FILTER_CACHE_TTL) {
      return data;
    }
  }
  
  const filters = await loadDatasetFilters(datasetId);
  localStorage.setItem(cacheKey, JSON.stringify({
    data: filters,
    timestamp: Date.now()
  }));
  
  return filters;
}
```

### CDN Deployment

Deploy dataset summaries to CloudFront for fast global access:

```bash
aws s3api put-bucket-cors --bucket dataset-bucket --cors-configuration file://cors.json
aws cloudfront create-distribution --distribution-config file://cloudfront-config.json
```

### Data Size Management

- Frame metadata (1000 frames, ~50 tags each): ~500 KB
- Video summaries (5 videos): ~30 KB
- Dataset summaries: ~50 KB
- **Total small enough for client-side caching**

---

## Querying by Tag

After user selects filter tags, query dataset using `dataset_tag_distribution.json`:

```javascript
async function queryVideosByTag(datasetId, selectedTag) {
  const key = `sample_data/${datasetId}/sample_analysis/metadata/dataset/dataset_tag_distribution.json`;
  const tagDistribution = await s3.getObject({ Bucket, Key: key })
    .promise()
    .then(r => JSON.parse(r.Body));
  
  // Get videos containing the tag
  const videos = tagDistribution[selectedTag].video_coverage;
  
  // Fetch video summaries to show frames
  const results = [];
  for (const videoName of videos) {
    const videoKey = `sample_data/${datasetId}/sample_analysis/metadata/videos/${videoName}.json`;
    const videoSummary = await s3.getObject({ Bucket, Key: videoKey })
      .promise()
      .then(r => JSON.parse(r.Body));
    
    results.push({
      video: videoName,
      frames: videoSummary.tag_details[selectedTag],
      totalTags: videoSummary.detected_tags.length
    });
  }
  
  return results;
}
```

---

## Summary

| Level | File | Purpose | Use Case |
|-------|------|---------|----------|
| **Frame** | `frames/{video}/{frame}.json` | Tag per frame | Detailed search |
| **Video** | `videos/{video}.json` | Aggregated per video | Video preview |
| **Dataset** | `dataset/dataset_filter_tags.json` | Website filters | **Main UI filters** |
| **Dataset** | `dataset/dataset_summary.json` | Overview stats | Dashboard card |
| **Dataset** | `dataset/dataset_tag_distribution.json` | Tag statistics | Data exploration |

**Primary file for website filters**: `dataset_filter_tags.json` ⭐
