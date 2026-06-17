#!/usr/bin/env python3
"""
Visualize CLIP embeddings on the unit sphere via tangent-space PCA.

Input: .npy of shape (n_clips, dim), rows L2-normalized (typical CLIP).
Outputs: PNG (3D sphere + 2D stereographic) and interactive HTML.
"""

from __future__ import annotations

import argparse
from pathlib import Path

import matplotlib.pyplot as plt
import numpy as np
import plotly.graph_objects as go
from mpl_toolkits.mplot3d import Axes3D  # noqa: F401
from sklearn.cluster import KMeans
from sklearn.decomposition import PCA


def load_embeddings(path: Path) -> np.ndarray:
    X = np.load(path, allow_pickle=False)
    if X.ndim != 2:
        raise ValueError(f"Expected 2D array (n, dim), got shape {X.shape}")
    X = np.asarray(X, dtype=np.float64)
    norms = np.linalg.norm(X, axis=1, keepdims=True)
    norms = np.maximum(norms, 1e-12)
    return X / norms


def spherical_mean_direction(X: np.ndarray) -> np.ndarray:
    mu = X.mean(axis=0)
    n = np.linalg.norm(mu)
    if n < 1e-12:
        mu = X[0].copy()
        n = np.linalg.norm(mu)
    return mu / n


def tangent_space_pca(X: np.ndarray, n_components: int = 3) -> tuple[np.ndarray, np.ndarray]:
    """
    PCA in the tangent space at the Fréchet mean direction, then map to S^{n_components-1}.
    """
    mu = spherical_mean_direction(X)
    # Project each unit vector into tangent space at mu
    dots = X @ mu
    T = X - dots[:, None] * mu
    pca = PCA(n_components=n_components)
    coords = pca.fit_transform(T)
    # Place on unit sphere in PC space
    norms = np.linalg.norm(coords, axis=1, keepdims=True)
    norms = np.maximum(norms, 1e-12)
    on_sphere = coords / norms
    return on_sphere, pca


def compute_derived_labels(n_clips: int, embeddings: np.ndarray, n_clusters: int = 8) -> dict:
    """
    The .npy stores only float32 embeddings (n, 512) — no tags/labels in file.
    Derive visualization labels: temporal phase + k-means clusters on embeddings.
    """
    third = max(1, n_clips // 3)
    temporal_phase = []
    for i in range(n_clips):
        if i < third:
            temporal_phase.append("early")
        elif i < 2 * third:
            temporal_phase.append("mid")
        else:
            temporal_phase.append("late")

    k = min(n_clusters, max(2, n_clips // 20))
    km = KMeans(n_clusters=k, random_state=42, n_init=10)
    cluster_ids = km.fit_predict(embeddings).astype(int).tolist()
    cluster_labels = [f"Cluster {c}" for c in cluster_ids]

    return {
        "temporalPhase": temporal_phase,
        "clusterIds": cluster_ids,
        "clusterLabels": cluster_labels,
        "nClusters": k,
        "hasFileTags": False,
    }


def stereographic_project(points_3d: np.ndarray) -> np.ndarray:
    """Stereographic projection from S^2 (z != -1) to R^2."""
    x, y, z = points_3d[:, 0], points_3d[:, 1], points_3d[:, 2]
    denom = 1.0 - z
    denom = np.where(np.abs(denom) < 1e-8, 1e-8, denom)
    u = x / denom
    v = y / denom
    return np.column_stack([u, v])


def draw_unit_sphere(ax, alpha: float = 0.12) -> None:
    u = np.linspace(0, 2 * np.pi, 48)
    v = np.linspace(0, np.pi, 24)
    xs = np.outer(np.cos(u), np.sin(v))
    ys = np.outer(np.sin(u), np.sin(v))
    zs = np.outer(np.ones_like(u), np.cos(v))
    ax.plot_surface(xs, ys, zs, color="#4a6fa5", alpha=alpha, linewidth=0, shade=True)


def plot_matplotlib(
    points_3d: np.ndarray,
    colors: np.ndarray,
    out_png: Path,
    title: str,
) -> None:
    fig = plt.figure(figsize=(14, 6), facecolor="#0f1117")

    ax3 = fig.add_subplot(121, projection="3d", facecolor="#0f1117")
    draw_unit_sphere(ax3)
    sc = ax3.scatter(
        points_3d[:, 0],
        points_3d[:, 1],
        points_3d[:, 2],
        c=colors,
        cmap="turbo",
        s=28,
        alpha=0.92,
        depthshade=True,
    )
    ax3.set_xlim(-1.05, 1.05)
    ax3.set_ylim(-1.05, 1.05)
    ax3.set_zlim(-1.05, 1.05)
    ax3.set_xlabel("PC1")
    ax3.set_ylabel("PC2")
    ax3.set_zlabel("PC3")
    ax3.set_title("Spherical PCA (3D)", color="#e8e8e8", fontsize=11)
    ax3.tick_params(colors="#888")
    ax3.xaxis.pane.fill = False
    ax3.yaxis.pane.fill = False
    ax3.zaxis.pane.fill = False

    ax2 = fig.add_subplot(122, facecolor="#0f1117")
    uv = stereographic_project(points_3d)
    ax2.scatter(uv[:, 0], uv[:, 1], c=colors, cmap="turbo", s=28, alpha=0.92)
    ax2.set_aspect("equal")
    ax2.set_xlabel("Stereographic u")
    ax2.set_ylabel("Stereographic v")
    ax2.set_title("Stereographic view", color="#e8e8e8", fontsize=11)
    ax2.tick_params(colors="#888")
    for spine in ax2.spines.values():
        spine.set_color("#444")

    fig.suptitle(title, color="#f0f0f0", fontsize=13, y=1.02)
    cbar = fig.colorbar(sc, ax=[ax3, ax2], shrink=0.65, pad=0.02)
    cbar.set_label("Clip index (time)", color="#ccc")
    cbar.ax.yaxis.set_tick_params(color="#888")
    plt.setp(plt.getp(cbar.ax.axes, "yticklabels"), color="#888")
    plt.tight_layout()
    fig.savefig(out_png, dpi=160, facecolor=fig.get_facecolor(), bbox_inches="tight")
    plt.close(fig)


def plot_plotly(
    points_3d: np.ndarray,
    colors: np.ndarray,
    out_html: Path,
    title: str,
) -> None:
    u = np.linspace(0, 2 * np.pi, 60)
    v = np.linspace(0, np.pi, 30)
    xs = np.outer(np.cos(u), np.sin(v))
    ys = np.outer(np.sin(u), np.sin(v))
    zs = np.outer(np.ones_like(u), np.cos(v))

    sphere = go.Surface(
        x=xs,
        y=ys,
        z=zs,
        opacity=0.15,
        colorscale=[[0, "#2a3550"], [1, "#4a6fa5"]],
        showscale=False,
        name="Unit sphere",
    )
    pts = go.Scatter3d(
        x=points_3d[:, 0],
        y=points_3d[:, 1],
        z=points_3d[:, 2],
        mode="markers",
        marker=dict(
            size=4,
            color=colors,
            colorscale="Turbo",
            colorbar=dict(title="Clip index"),
            opacity=0.95,
        ),
        text=[f"clip {i}" for i in range(len(colors))],
        hovertemplate="%{text}<br>x=%{x:.3f}<br>y=%{y:.3f}<br>z=%{z:.3f}<extra></extra>",
        name="Embeddings",
    )
    fig = go.Figure(data=[sphere, pts])
    fig.update_layout(
        title=title,
        template="plotly_dark",
        scene=dict(
            xaxis=dict(range=[-1.1, 1.1], title="PC1"),
            yaxis=dict(range=[-1.1, 1.1], title="PC2"),
            zaxis=dict(range=[-1.1, 1.1], title="PC3"),
            aspectmode="cube",
        ),
        margin=dict(l=0, r=0, t=40, b=0),
    )
    fig.write_html(str(out_html), include_plotlyjs="cdn")


def main() -> None:
    parser = argparse.ArgumentParser(description="Spherical PCA plot for CLIP embeddings")
    parser.add_argument(
        "npy_path",
        nargs="?",
        default="400661_0062_20240612_184739_clip_embeddings.npy",
        help="Path to .npy (n_clips, dim)",
    )
    parser.add_argument("--out-dir", default="plots", help="Output directory")
    args = parser.parse_args()

    npy_path = Path(args.npy_path)
    if not npy_path.is_file():
        raise SystemExit(f"File not found: {npy_path}")

    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    stem = npy_path.stem.replace("_clip_embeddings", "")
    X = load_embeddings(npy_path)
    n_clips, dim = X.shape

    points_3d, _pca = tangent_space_pca(X, n_components=3)
    colors = np.arange(n_clips)

    title = f"Spherical PCA — {stem} ({n_clips} clips, dim={dim})"
    png_path = out_dir / f"{stem}_spherical_pca.png"
    html_path = out_dir / f"{stem}_spherical_pca.html"

    plot_matplotlib(points_3d, colors, png_path, title)
    plot_plotly(points_3d, colors, html_path, title)

    json_path = out_dir / f"{stem}_spherical_pca.json"
    import json

    derived = compute_derived_labels(n_clips, X)
    json_path.write_text(
        json.dumps(
            {
                "success": True,
                "nClips": int(n_clips),
                "dim": int(dim),
                "points": points_3d.tolist(),
                "stereographic": stereographic_project(points_3d).tolist(),
                "clipIndices": list(range(int(n_clips))),
                "source": str(npy_path),
                **derived,
            },
            indent=0,
        )
    )

    print(f"Loaded: {npy_path}  shape={X.shape}")
    print(f"Wrote: {png_path}")
    print(f"Wrote: {html_path}")
    print(f"Wrote: {json_path}")


if __name__ == "__main__":
    main()
