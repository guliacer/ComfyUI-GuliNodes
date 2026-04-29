import torch
import torch.nn.functional as torch_F
from PIL import Image, ImageDraw, ImageFont
from PIL.PngImagePlugin import PngInfo
import numpy as np
from nodes import PreviewImage, SaveImage
from comfy.cli_args import args
import folder_paths
import json
import os
import tempfile
from datetime import datetime
from typing import Any

try:
    import cv2
except Exception:
    cv2 = None

try:
    import mediapipe as mp
except Exception:
    mp = None


_MP_FACE_DETECTOR = None
_MP_FACE_MESH = None
_CV_SMILE_DETECTOR = None


def _get_mediapipe_solutions():
    if mp is None:
        return None
    return getattr(mp, "solutions", None)


def _empty_image(device=None, dtype=torch.float32) -> torch.Tensor:
    return torch.zeros([1, 64, 64, 3], device=device, dtype=dtype)


def _align_to_eight(value: int) -> int:
    return max(8, (int(value) // 8) * 8)


def _resize_image(image: torch.Tensor, height: int, width: int, mode: str) -> torch.Tensor:
    image_ch = image.permute(0, 3, 1, 2).contiguous()
    kwargs = {"size": (height, width), "mode": mode}
    if mode in ("bilinear", "bicubic"):
        kwargs.update({"align_corners": False, "antialias": True})
    resized = torch_F.interpolate(image_ch, **kwargs)
    return resized.permute(0, 2, 3, 1).contiguous()


def _channel_kernel(kernel: torch.Tensor, channels: int, image: torch.Tensor) -> torch.Tensor:
    return kernel.to(device=image.device, dtype=image.dtype).view(1, 1, 3, 3).repeat(channels, 1, 1, 1)


def _to_rgb_image(image: torch.Tensor) -> torch.Tensor:
    if image is None:
        return _empty_image()
    if image.shape[-1] == 1:
        return image.expand(*image.shape[:-1], 3).contiguous()
    if image.shape[-1] == 2:
        gray = image[..., :1].expand(*image.shape[:-1], 3)
        alpha = image[..., 1:2].clamp(0.0, 1.0)
        return torch.clamp(gray * alpha + (1.0 - alpha), 0.0, 1.0).contiguous()
    if image.shape[-1] >= 4:
        rgb = image[..., :3]
        alpha = image[..., 3:4].clamp(0.0, 1.0)
        return torch.clamp(rgb * alpha + (1.0 - alpha), 0.0, 1.0).contiguous()
    if image.shape[-1] == 3:
        return image
    return _empty_image(image.device, image.dtype)


def _pil_to_tensor(image: Image.Image, device=None, dtype=torch.float32) -> torch.Tensor:
    rgb_image = image.convert("RGB")
    array = np.asarray(rgb_image).astype(np.float32) / 255.0
    tensor = torch.from_numpy(array)
    if device is not None:
        tensor = tensor.to(device=device, dtype=dtype)
    elif dtype is not None:
        tensor = tensor.to(dtype=dtype)
    return tensor


def _resolve_output_prefix(prefix: str) -> str:
    if not isinstance(prefix, str):
        return prefix
    return prefix.replace("%date:yyyy_MM_dd%", datetime.now().strftime("%Y_%m_%d"))


def _rect_iou(rect_a: tuple, rect_b: tuple) -> float:
    ax1, ay1, aw, ah = rect_a
    bx1, by1, bw, bh = rect_b
    ax2, ay2 = ax1 + aw, ay1 + ah
    bx2, by2 = bx1 + bw, by1 + bh
    inter_x1 = max(ax1, bx1)
    inter_y1 = max(ay1, by1)
    inter_x2 = min(ax2, bx2)
    inter_y2 = min(ay2, by2)
    if inter_x2 <= inter_x1 or inter_y2 <= inter_y1:
        return 0.0
    inter_area = float((inter_x2 - inter_x1) * (inter_y2 - inter_y1))
    union_area = float(aw * ah + bw * bh) - inter_area
    if union_area <= 0:
        return 0.0
    return inter_area / union_area


def _merge_face_detections(detections: list[tuple[int, int, int, int]]) -> list[tuple[int, int, int, int]]:
    merged: list[list[float]] = []
    for rect in sorted(detections, key=lambda item: item[2] * item[3], reverse=True):
        x, y, w, h = rect
        matched = False
        for current in merged:
            current_rect = tuple(map(int, current[:4]))
            if _rect_iou((x, y, w, h), current_rect) >= 0.28:
                total_weight = current[4] + 1.0
                current[0] = (current[0] * current[4] + x) / total_weight
                current[1] = (current[1] * current[4] + y) / total_weight
                current[2] = (current[2] * current[4] + w) / total_weight
                current[3] = (current[3] * current[4] + h) / total_weight
                current[4] = total_weight
                matched = True
                break
        if not matched:
            merged.append([float(x), float(y), float(w), float(h), 1.0])
    return [tuple(int(round(value)) for value in item[:4]) for item in merged]


def _get_mediapipe_face_detector():
    global _MP_FACE_DETECTOR
    solutions = _get_mediapipe_solutions()
    if solutions is None or not hasattr(solutions, "face_detection"):
        return None
    if _MP_FACE_DETECTOR is None:
        try:
            _MP_FACE_DETECTOR = solutions.face_detection.FaceDetection(
                model_selection=1,
                min_detection_confidence=0.35,
            )
        except Exception:
            _MP_FACE_DETECTOR = False
    return _MP_FACE_DETECTOR if _MP_FACE_DETECTOR is not False else None


def _get_mediapipe_face_mesh():
    global _MP_FACE_MESH
    solutions = _get_mediapipe_solutions()
    if solutions is None or not hasattr(solutions, "face_mesh"):
        return None
    if _MP_FACE_MESH is None:
        try:
            _MP_FACE_MESH = solutions.face_mesh.FaceMesh(
                static_image_mode=True,
                max_num_faces=10,
                refine_landmarks=True,
                min_detection_confidence=0.35,
                min_tracking_confidence=0.35,
            )
        except Exception:
            _MP_FACE_MESH = False
    return _MP_FACE_MESH if _MP_FACE_MESH is not False else None


def _connection_indices(connections) -> list[int]:
    values = set()
    for a, b in connections:
        values.add(int(a))
        values.add(int(b))
    return sorted(values)


def _get_face_mesh_index_sets() -> dict[str, list[int]]:
    solutions = _get_mediapipe_solutions()
    if solutions is None or not hasattr(solutions, "face_mesh_connections"):
        return {}
    connections = solutions.face_mesh_connections
    return {
        "oval": _connection_indices(connections.FACEMESH_FACE_OVAL),
        "lips": _connection_indices(connections.FACEMESH_LIPS),
        "left_eye": _connection_indices(connections.FACEMESH_LEFT_EYE),
        "right_eye": _connection_indices(connections.FACEMESH_RIGHT_EYE),
        "left_eyebrow": _connection_indices(connections.FACEMESH_LEFT_EYEBROW),
        "right_eyebrow": _connection_indices(connections.FACEMESH_RIGHT_EYEBROW),
        "left_iris": _connection_indices(getattr(connections, "FACEMESH_LEFT_IRIS", [])),
        "right_iris": _connection_indices(getattr(connections, "FACEMESH_RIGHT_IRIS", [])),
    }


def _get_mediapipe_face_meshes(image_u8: np.ndarray) -> list[dict[str, Any]]:
    mesh = _get_mediapipe_face_mesh()
    if mesh is None or image_u8 is None or image_u8.size == 0:
        return []
    try:
        results = mesh.process(image_u8)
    except Exception:
        return []
    if not results or not results.multi_face_landmarks:
        return []

    height, width = image_u8.shape[:2]
    outputs = []
    for face_landmarks in results.multi_face_landmarks:
        try:
            points = []
            for landmark in face_landmarks.landmark:
                px = float(np.clip(landmark.x, 0.0, 1.0) * width)
                py = float(np.clip(landmark.y, 0.0, 1.0) * height)
                points.append((px, py))
            points_np = np.asarray(points, dtype=np.float32)
            min_xy = points_np.min(axis=0)
            max_xy = points_np.max(axis=0)
            x1 = max(0, int(min_xy[0]))
            y1 = max(0, int(min_xy[1]))
            x2 = min(width, int(max_xy[0]))
            y2 = min(height, int(max_xy[1]))
            if x2 <= x1 + 1 or y2 <= y1 + 1:
                continue
            outputs.append(
                {
                    "bbox": (x1, y1, x2 - x1, y2 - y1),
                    "landmarks": points_np,
                }
            )
        except Exception:
            continue
    return outputs


def _match_mediapipe_mesh(face: tuple, mesh_results: list[dict[str, Any]]) -> dict[str, Any] | None:
    best_match = None
    best_score = 0.0
    for mesh in mesh_results:
        bbox = mesh.get("bbox")
        if bbox is None:
            continue
        iou = _rect_iou(face, bbox)
        if iou > best_score:
            best_score = iou
            best_match = mesh
    if best_score >= 0.10:
        return best_match
    return None


def _landmark_points(landmarks: np.ndarray, indices: list[int]) -> np.ndarray:
    if landmarks is None or len(indices) == 0:
        return np.empty((0, 2), dtype=np.int32)
    valid = [idx for idx in indices if 0 <= idx < len(landmarks)]
    if not valid:
        return np.empty((0, 2), dtype=np.int32)
    points = landmarks[valid]
    return np.round(points).astype(np.int32)


def _fill_landmark_region(mask: np.ndarray, landmarks: np.ndarray, indices: list[int], value: float | int) -> bool:
    points = _landmark_points(landmarks, indices)
    if len(points) < 3:
        return False
    hull = cv2.convexHull(points)
    cv2.fillConvexPoly(mask, hull, value)
    return True


def _landmark_region_bbox(landmarks: np.ndarray, indices: list[int], shape: tuple[int, int]) -> tuple[int, int, int, int] | None:
    points = _landmark_points(landmarks, indices)
    if len(points) < 3:
        return None
    x, y, w, h = cv2.boundingRect(points)
    height, width = shape[:2]
    x = max(0, min(int(x), width - 1))
    y = max(0, min(int(y), height - 1))
    w = max(1, min(int(w), width - x))
    h = max(1, min(int(h), height - y))
    return (x, y, w, h)


def _landmark_region_mask_in_bbox(landmarks: np.ndarray, indices: list[int], bbox: tuple[int, int, int, int]) -> np.ndarray | None:
    points = _landmark_points(landmarks, indices)
    if len(points) < 3:
        return None
    x, y, w, h = bbox
    mask = np.zeros((h, w), dtype=np.float32)
    local_points = points - np.array([[x, y]], dtype=np.int32)
    local_points[:, 0] = np.clip(local_points[:, 0], 0, max(0, w - 1))
    local_points[:, 1] = np.clip(local_points[:, 1], 0, max(0, h - 1))
    hull = cv2.convexHull(local_points.astype(np.int32))
    cv2.fillConvexPoly(mask, hull, 1.0)
    if mask.max() > 0:
        mask = cv2.GaussianBlur(mask, (0, 0), sigmaX=1.2, sigmaY=1.2)
    return np.clip(mask, 0.0, 1.0)


def _expand_bbox(bbox: tuple[int, int, int, int], shape: tuple[int, int], pad_x: float = 0.10, pad_y: float = 0.12) -> tuple[int, int, int, int]:
    x, y, w, h = bbox
    height, width = shape[:2]
    ex = max(1, int(w * pad_x))
    ey = max(1, int(h * pad_y))
    x1 = max(0, x - ex)
    y1 = max(0, y - ey)
    x2 = min(width, x + w + ex)
    y2 = min(height, y + h + ey)
    return (x1, y1, max(1, x2 - x1), max(1, y2 - y1))


def _build_eye_white_mask_from_mesh(landmarks: np.ndarray, side: str, image_shape: tuple[int, int]) -> tuple[tuple[int, int, int, int], np.ndarray] | None:
    indices = _get_face_mesh_index_sets()
    eye_indices = indices.get(f"{side}_eye", [])
    iris_indices = indices.get(f"{side}_iris", [])
    eye_bbox = _landmark_region_bbox(landmarks, eye_indices, image_shape)
    if eye_bbox is None:
        return None
    eye_bbox = _expand_bbox(eye_bbox, image_shape, pad_x=0.12, pad_y=0.18)
    eye_mask = _landmark_region_mask_in_bbox(landmarks, eye_indices, eye_bbox)
    if eye_mask is None:
        return None
    if iris_indices:
        iris_mask = _landmark_region_mask_in_bbox(landmarks, iris_indices, eye_bbox)
        if iris_mask is not None:
            eye_mask = np.clip(eye_mask - iris_mask * 1.15, 0.0, 1.0)
    if eye_mask.max() > 0:
        eye_mask = cv2.GaussianBlur(eye_mask, (0, 0), sigmaX=1.0, sigmaY=1.0)
    return eye_bbox, np.clip(eye_mask, 0.0, 1.0)


def _get_mediapipe_face_detections(image_u8: np.ndarray) -> list[dict[str, Any]]:
    detector = _get_mediapipe_face_detector()
    solutions = _get_mediapipe_solutions()
    if detector is None or image_u8 is None or image_u8.size == 0:
        return []
    if solutions is None or not hasattr(solutions, "face_detection"):
        return []
    try:
        results = detector.process(image_u8)
    except Exception:
        return []
    if not results or not results.detections:
        return []

    height, width = image_u8.shape[:2]
    detections = []
    key_names = [
        "right_eye",
        "left_eye",
        "nose_tip",
        "mouth_center",
        "right_ear",
        "left_ear",
    ]
    for detection in results.detections:
        try:
            rel_box = detection.location_data.relative_bounding_box
            x = max(0, int(rel_box.xmin * width))
            y = max(0, int(rel_box.ymin * height))
            w = int(rel_box.width * width)
            h = int(rel_box.height * height)
            w = max(1, min(w, width - x))
            h = max(1, min(h, height - y))
            keypoints = {}
            for key_name, face_key in zip(key_names, solutions.face_detection.FaceKeyPoint):
                point = solutions.face_detection.get_key_point(detection, face_key)
                keypoints[key_name] = (float(point.x * width), float(point.y * height))
            detections.append(
                {
                    "bbox": (x, y, w, h),
                    "score": float(detection.score[0]) if detection.score else 0.0,
                    "keypoints": keypoints,
                }
            )
        except Exception:
            continue
    return detections


def _match_mediapipe_detection(face: tuple, mp_detections: list[dict[str, Any]]) -> dict[str, Any] | None:
    best_match = None
    best_score = 0.0
    for detection in mp_detections:
        bbox = detection.get("bbox")
        if bbox is None:
            continue
        iou = _rect_iou(face, bbox)
        if iou > best_score:
            best_score = iou
            best_match = detection
    if best_score >= 0.12:
        return best_match
    return None


def _build_face_analysis_context(image_u8: np.ndarray, sensitivity: int = 60) -> dict[str, Any]:
    gray = cv2.cvtColor(image_u8, cv2.COLOR_RGB2GRAY) if cv2 is not None and image_u8 is not None and image_u8.size > 0 else None
    mp_detections = _get_mediapipe_face_detections(image_u8) if image_u8 is not None else []
    mesh_results = _get_mediapipe_face_meshes(image_u8) if image_u8 is not None else []
    return {
        "image_u8": image_u8,
        "gray": gray,
        "sensitivity": sensitivity,
        "mp_detections": mp_detections,
        "mesh_results": mesh_results,
        "mesh_indices": _get_face_mesh_index_sets(),
        "mouth_regions": {},
        "pose_cache": {},
    }


def _get_smile_detector():
    global _CV_SMILE_DETECTOR
    if cv2 is None:
        return None
    if _CV_SMILE_DETECTOR is None:
        try:
            detector = cv2.CascadeClassifier(cv2.data.haarcascades + "haarcascade_smile.xml")
            _CV_SMILE_DETECTOR = detector if not detector.empty() else False
        except Exception:
            _CV_SMILE_DETECTOR = False
    return _CV_SMILE_DETECTOR if _CV_SMILE_DETECTOR is not False else None


def _detect_mouth_region(image_u8: np.ndarray, face: tuple, context: dict[str, Any] | None = None) -> tuple[int, int, int, int] | None:
    if cv2 is None or image_u8 is None or image_u8.size == 0:
        return None
    if context is not None:
        cached = context.get("mouth_regions", {}).get(face)
        if cached is not None:
            return cached
    x, y, w, h = face
    gray = context.get("gray") if context is not None else cv2.cvtColor(image_u8, cv2.COLOR_RGB2GRAY)
    mesh_results = context.get("mesh_results", []) if context is not None else _get_mediapipe_face_meshes(image_u8)
    mesh_indices = context.get("mesh_indices", _get_face_mesh_index_sets()) if context is not None else _get_face_mesh_index_sets()
    mesh_match = _match_mediapipe_mesh(face, mesh_results)
    if mesh_match is not None:
        lips_bbox = _landmark_region_bbox(
            mesh_match.get("landmarks"),
            mesh_indices.get("lips", []),
            image_u8.shape[:2],
        )
        if lips_bbox is not None:
            if context is not None:
                context["mouth_regions"][face] = lips_bbox
            return lips_bbox

    mp_detections = context.get("mp_detections", []) if context is not None else _get_mediapipe_face_detections(image_u8)
    mp_detection = _match_mediapipe_detection(face, mp_detections)
    if mp_detection is not None:
        mouth_center = mp_detection.get("keypoints", {}).get("mouth_center")
        if mouth_center is not None:
            mx, my = mouth_center
            mw = max(8, int(w * 0.34))
            mh = max(6, int(h * 0.18))
            x1 = max(0, int(mx - mw * 0.5))
            y1 = max(0, int(my - mh * 0.42))
            x2 = min(image_u8.shape[1], int(mx + mw * 0.5))
            y2 = min(image_u8.shape[0], int(my + mh * 0.58))
            if x2 > x1 + 2 and y2 > y1 + 2:
                region = (x1, y1, x2 - x1, y2 - y1)
                if context is not None:
                    context["mouth_regions"][face] = region
                return region

    detector = _get_smile_detector()
    if detector is not None:
        roi_x1 = max(0, x + int(w * 0.12))
        roi_x2 = min(image_u8.shape[1], x + int(w * 0.88))
        roi_y1 = max(0, y + int(h * 0.46))
        roi_y2 = min(image_u8.shape[0], y + int(h * 0.92))
        roi = gray[roi_y1:roi_y2, roi_x1:roi_x2]
        if roi.size > 0 and min(roi.shape[:2]) >= 12:
            smile_candidates = []
            for scale_factor, min_neighbors in ((1.5, 20), (1.35, 15), (1.25, 10)):
                smiles = detector.detectMultiScale(
                    roi,
                    scaleFactor=scale_factor,
                    minNeighbors=min_neighbors,
                    minSize=(max(10, int(w * 0.12)), max(6, int(h * 0.05))),
                )
                for sx, sy, sw, sh in smiles:
                    if sy < roi.shape[0] * 0.08:
                        continue
                    smile_candidates.append((roi_x1 + int(sx), roi_y1 + int(sy), int(sw), int(sh)))
            if smile_candidates:
                smile_candidates = sorted(
                    smile_candidates,
                    key=lambda item: (item[2] * item[3], item[1] + item[3] * 0.5),
                    reverse=True,
                )
                return smile_candidates[0]

    fallback_x1 = max(0, x + int(w * 0.18))
    fallback_y1 = max(0, y + int(h * 0.60))
    fallback_x2 = min(image_u8.shape[1], x + int(w * 0.82))
    fallback_y2 = min(image_u8.shape[0], y + int(h * 0.84))
    if fallback_x2 > fallback_x1 + 2 and fallback_y2 > fallback_y1 + 2:
        region = (fallback_x1, fallback_y1, fallback_x2 - fallback_x1, fallback_y2 - fallback_y1)
        if context is not None:
            context["mouth_regions"][face] = region
        return region
    return None


def _detect_faces_robust(
    image_u8: np.ndarray,
    sensitivity: int = 50,
    include_profile: bool = True,
    context: dict[str, Any] | None = None,
) -> list[tuple[int, int, int, int]]:
    if cv2 is None or image_u8 is None or image_u8.size == 0:
        return []
    gray = context.get("gray") if context is not None else cv2.cvtColor(image_u8, cv2.COLOR_RGB2GRAY)
    height, width = gray.shape[:2]
    min_side = max(16, int(min(height, width) * 0.04))
    sensitivity = max(0, min(int(sensitivity), 100))
    frontal_models = [
        cv2.CascadeClassifier(cv2.data.haarcascades + "haarcascade_frontalface_default.xml"),
        cv2.CascadeClassifier(cv2.data.haarcascades + "haarcascade_frontalface_alt2.xml"),
    ]
    profile = cv2.CascadeClassifier(cv2.data.haarcascades + "haarcascade_profileface.xml") if include_profile else None

    passes = [
        (1.03, max(2, 5 - sensitivity // 24), max(14, min_side // 2)),
        (1.06, max(2, 6 - sensitivity // 20), max(18, int(min_side * 0.65))),
        (1.10, max(2, 7 - sensitivity // 16), max(22, min_side)),
    ]

    detections: list[tuple[int, int, int, int]] = []
    mp_detections = context.get("mp_detections", []) if context is not None else _get_mediapipe_face_detections(image_u8)
    detections.extend(detection["bbox"] for detection in mp_detections if detection.get("bbox"))

    for frontal in frontal_models:
        if frontal.empty():
            continue
        for scale_factor, min_neighbors, min_size in passes:
            faces = frontal.detectMultiScale(
                gray,
                scaleFactor=scale_factor,
                minNeighbors=min_neighbors,
                minSize=(min_size, min_size),
            )
            detections.extend(tuple(map(int, face)) for face in faces)

    region_boxes = [
        (0, 0, width, height),
        (0, 0, int(width * 0.68), int(height * 0.68)),
        (int(width * 0.32), 0, width, int(height * 0.68)),
        (0, int(height * 0.32), int(width * 0.68), height),
        (int(width * 0.32), int(height * 0.32), width, height),
    ]
    for x1, y1, x2, y2 in region_boxes:
        roi = gray[y1:y2, x1:x2]
        if roi.size == 0 or min(roi.shape[:2]) < 32:
            continue
        region_min_side = max(12, int(min(roi.shape[:2]) * 0.08))
        for frontal in frontal_models:
            if frontal.empty():
                continue
            faces = frontal.detectMultiScale(
                roi,
                scaleFactor=1.04,
                minNeighbors=max(2, 5 - sensitivity // 25),
                minSize=(region_min_side, region_min_side),
            )
            for fx, fy, fw, fh in faces:
                detections.append((int(fx + x1), int(fy + y1), int(fw), int(fh)))

    if include_profile and profile is not None and not profile.empty():
        profile_passes = [
            (1.05, max(2, 4 - sensitivity // 28), max(14, int(min_side * 0.55))),
            (1.08, max(2, 5 - sensitivity // 24), max(18, int(min_side * 0.70))),
        ]
        flipped = cv2.flip(gray, 1)
        for scale_factor, min_neighbors, min_size in profile_passes:
            faces = profile.detectMultiScale(
                gray,
                scaleFactor=scale_factor,
                minNeighbors=min_neighbors,
                minSize=(min_size, min_size),
            )
            detections.extend(tuple(map(int, face)) for face in faces)

            mirrored = profile.detectMultiScale(
                flipped,
                scaleFactor=scale_factor,
                minNeighbors=min_neighbors,
                minSize=(min_size, min_size),
            )
            for x, y, w, h in mirrored:
                detections.append((int(width - x - w), int(y), int(w), int(h)))

        profile_regions = [
            (0, 0, int(width * 0.72), height),
            (int(width * 0.28), 0, width, height),
            (0, 0, width, int(height * 0.74)),
            (0, int(height * 0.18), width, height),
            (0, 0, int(width * 0.60), int(height * 0.78)),
            (int(width * 0.40), 0, width, int(height * 0.78)),
        ]
        for x1, y1, x2, y2 in profile_regions:
            roi = gray[y1:y2, x1:x2]
            if roi.size == 0 or min(roi.shape[:2]) < 28:
                continue
            flipped_roi = cv2.flip(roi, 1)
            region_min_side = max(12, int(min(roi.shape[:2]) * 0.07))
            for scale_factor, min_neighbors, _ in profile_passes:
                faces = profile.detectMultiScale(
                    roi,
                    scaleFactor=scale_factor,
                    minNeighbors=min_neighbors,
                    minSize=(region_min_side, region_min_side),
                )
                for fx, fy, fw, fh in faces:
                    detections.append((int(fx + x1), int(fy + y1), int(fw), int(fh)))

                mirrored = profile.detectMultiScale(
                    flipped_roi,
                    scaleFactor=scale_factor,
                    minNeighbors=min_neighbors,
                    minSize=(region_min_side, region_min_side),
                )
                roi_width = roi.shape[1]
                for fx, fy, fw, fh in mirrored:
                    detections.append((int(x1 + roi_width - fx - fw), int(fy + y1), int(fw), int(fh)))

    cleaned = []
    for x, y, w, h in detections:
        x = max(0, min(int(x), width - 1))
        y = max(0, min(int(y), height - 1))
        w = max(1, min(int(w), width - x))
        h = max(1, min(int(h), height - y))
        if w < 16 or h < 16:
            continue
        cleaned.append((x, y, w, h))
    return _merge_face_detections(cleaned)


def _detect_eyes_robust(gray: np.ndarray, face: tuple, sensitivity: int) -> list[tuple[int, int, int, int]]:
    x, y, w, h = face
    roi_h = int(h * 0.62)
    roi = gray[y:y + roi_h, x:x + w]
    if roi.size == 0:
        return []

    detectors = [
        cv2.CascadeClassifier(cv2.data.haarcascades + "haarcascade_eye.xml"),
        cv2.CascadeClassifier(cv2.data.haarcascades + "haarcascade_eye_tree_eyeglasses.xml"),
    ]
    min_neighbors = max(2, min(8, 7 - int(sensitivity / 25)))
    base_min_size = max(8, min(w // 10, h // 10))
    candidates: list[tuple[int, int, int, int]] = []

    search_regions = [
        (0, 0, w, roi_h),
        (0, 0, int(w * 0.58), roi_h),
        (int(w * 0.42), 0, w, roi_h),
    ]
    for detector in detectors:
        if detector.empty():
            continue
        for rx1, ry1, rx2, ry2 in search_regions:
            sub_roi = roi[ry1:ry2, rx1:rx2]
            if sub_roi.size == 0 or min(sub_roi.shape[:2]) < base_min_size:
                continue
            eyes = detector.detectMultiScale(
                sub_roi,
                scaleFactor=1.05,
                minNeighbors=min_neighbors,
                minSize=(base_min_size, base_min_size),
            )
            for ex, ey, ew, eh in eyes:
                global_eye = (x + int(rx1 + ex), y + int(ry1 + ey), int(ew), int(eh))
                if global_eye[1] > y + h * 0.48:
                    continue
                candidates.append(global_eye)

    merged = _merge_face_detections(candidates)
    if not merged:
        return []

    left_side = [eye for eye in merged if eye[0] + eye[2] * 0.5 <= x + w * 0.55]
    right_side = [eye for eye in merged if eye[0] + eye[2] * 0.5 >= x + w * 0.45]

    def _pick_best(eyes: list[tuple[int, int, int, int]], reverse: bool = False):
        if not eyes:
            return None
        ordered = sorted(
            eyes,
            key=lambda item: (item[2] * item[3], -abs((item[1] + item[3] * 0.5) - (y + h * 0.32))),
            reverse=True,
        )
        if reverse:
            ordered = sorted(
                ordered,
                key=lambda item: (item[0] + item[2] * 0.5),
                reverse=True,
            )
        else:
            ordered = sorted(ordered, key=lambda item: (item[0] + item[2] * 0.5))
        return max(ordered[:2], key=lambda item: item[2] * item[3])

    selected = []
    left_eye = _pick_best(left_side, reverse=False)
    right_eye = _pick_best(right_side, reverse=True)
    if left_eye is not None:
        selected.append(left_eye)
    if right_eye is not None and (left_eye is None or _rect_iou(left_eye, right_eye) < 0.2):
        selected.append(right_eye)
    if not selected:
        selected = sorted(merged, key=lambda item: item[2] * item[3], reverse=True)[:2]
    return sorted(selected, key=lambda item: item[0])


def _analyze_face_pose(gray: np.ndarray | None, face: tuple, sensitivity: int = 60, image_u8: np.ndarray | None = None, context: dict[str, Any] | None = None) -> tuple[float, float]:
    if context is not None and face in context.get("pose_cache", {}):
        return context["pose_cache"][face]
    x, y, w, h = face
    if gray is None:
        return 0.0, 0.0
    if image_u8 is not None:
        mp_detections = context.get("mp_detections", []) if context is not None else _get_mediapipe_face_detections(image_u8)
        mp_detection = _match_mediapipe_detection(face, mp_detections)
        if mp_detection is not None:
            keypoints = mp_detection.get("keypoints", {})
            left_eye = keypoints.get("left_eye")
            right_eye = keypoints.get("right_eye")
            nose_tip = keypoints.get("nose_tip")
            horizontal_shift = 0.0
            profile_strength = 0.0
            face_center_x = x + w * 0.5
            if left_eye is not None and right_eye is not None:
                eye_center = (left_eye[0] + right_eye[0]) * 0.5
                eye_span = abs(right_eye[0] - left_eye[0])
                horizontal_shift = np.clip((eye_center - face_center_x) / max(1.0, w * 0.45), -1.0, 1.0)
                profile_strength = np.clip(1.0 - eye_span / max(1.0, w * 0.42), 0.0, 0.80)
            if nose_tip is not None:
                nose_shift = np.clip((nose_tip[0] - face_center_x) / max(1.0, w * 0.32), -1.0, 1.0)
                horizontal_shift = np.clip(horizontal_shift * 0.45 + nose_shift * 0.55, -1.0, 1.0)
                profile_strength = max(profile_strength, abs(nose_shift) * 0.95)
            if left_eye is None or right_eye is None:
                profile_strength = max(profile_strength, 0.65)
            if profile_strength > 0.0:
                value = (float(horizontal_shift), float(np.clip(profile_strength, 0.0, 1.0)))
                if context is not None:
                    context["pose_cache"][face] = value
                return value
    eyes = _detect_eyes_robust(gray, face, sensitivity)
    face_center_x = x + w * 0.5
    profile_strength = 0.0
    horizontal_shift = 0.0

    if len(eyes) >= 2:
        left = eyes[0][0] + eyes[0][2] * 0.5
        right = eyes[-1][0] + eyes[-1][2] * 0.5
        eye_center = (left + right) * 0.5
        horizontal_shift = np.clip((eye_center - face_center_x) / max(1.0, w * 0.45), -1.0, 1.0)
        eye_span = max(1.0, right - left)
        profile_strength = np.clip(1.0 - eye_span / max(1.0, w * 0.42), 0.0, 0.75)
    elif len(eyes) == 1:
        eye_center = eyes[0][0] + eyes[0][2] * 0.5
        horizontal_shift = np.clip((eye_center - face_center_x) / max(1.0, w * 0.40), -1.0, 1.0)
        profile_strength = 0.75
    else:
        aspect_profile = np.clip((1.0 - (w / max(float(h), 1.0))) * 1.6, 0.0, 0.55)
        profile_strength = aspect_profile

    if abs(horizontal_shift) < 0.08 and profile_strength > 0.45:
        horizontal_shift = 0.22 if w < h else 0.0
    value = (float(horizontal_shift), float(np.clip(profile_strength, 0.0, 1.0)))
    if context is not None:
        context["pose_cache"][face] = value
    return value


def _build_face_mask(
    shape: tuple,
    faces: list,
    expansion: float,
    vertical_scale: float = 1.15,
    blur_sigma: float = 10.0,
    gray: np.ndarray | None = None,
    sensitivity: int = 60,
    image_u8: np.ndarray | None = None,
    context: dict[str, Any] | None = None,
) -> np.ndarray:
    height, width = shape[:2]
    mask = np.zeros((height, width), dtype=np.uint8)
    mesh_results = context.get("mesh_results", []) if context is not None else (_get_mediapipe_face_meshes(image_u8) if image_u8 is not None else [])
    mesh_indices = context.get("mesh_indices", _get_face_mesh_index_sets()) if context is not None else _get_face_mesh_index_sets()
    for face in faces:
        x, y, w, h = face
        cx = x + w / 2.0
        mesh_match = _match_mediapipe_mesh(face, mesh_results)
        if mesh_match is not None and _fill_landmark_region(mask, mesh_match.get("landmarks"), mesh_indices.get("oval", []), 255):
            dilate_kernel = max(1, int(max(w, h) * max(1.0, expansion - 1.0) * 0.08))
            if dilate_kernel > 0:
                kernel = np.ones((dilate_kernel * 2 + 1, dilate_kernel * 2 + 1), dtype=np.uint8)
                mask = cv2.dilate(mask, kernel, iterations=1)
        else:
            cy = y + h / 2.0
            shift, profile_strength = _analyze_face_pose(gray, face, sensitivity=sensitivity, image_u8=image_u8, context=context)
            axes_x = max(1, int(w * expansion * (0.50 + profile_strength * 0.10)))
            axes_y = max(1, int(h * expansion * vertical_scale / 2.0))
            center_x = cx + shift * w * 0.08
            rotation = shift * profile_strength * 18.0
            cv2.ellipse(mask, (int(center_x), int(cy)), (axes_x, axes_y), rotation, 0, 360, 255, -1)

            if profile_strength > 0.18:
                profile_direction = 1.0 if shift >= 0 else -1.0
                forward_center = (int(cx + profile_direction * w * (0.08 + profile_strength * 0.10)), int(cy + h * 0.02))
                forward_axes = (
                    max(1, int(w * expansion * (0.20 + profile_strength * 0.10))),
                    max(1, int(h * expansion * 0.40)),
                )
                jaw_center = (int(cx + profile_direction * w * 0.05), int(cy + h * 0.12))
                jaw_axes = (
                    max(1, int(w * expansion * 0.24)),
                    max(1, int(h * expansion * (0.26 + profile_strength * 0.06))),
                )
                cv2.ellipse(mask, forward_center, forward_axes, rotation, 0, 360, 255, -1)
                cv2.ellipse(mask, jaw_center, jaw_axes, rotation, 0, 360, 255, -1)
    if mask.max() > 0 and blur_sigma > 0:
        mask = cv2.GaussianBlur(mask, (0, 0), sigmaX=blur_sigma, sigmaY=blur_sigma)
    return mask


def _gaussian_blur(image: torch.Tensor, kernel_size: int | None = None, sigma: float = 1.0) -> torch.Tensor:
    sigma = max(float(sigma), 0.001)
    if kernel_size is None:
        kernel_size = int(sigma * 6) + 1
    kernel_size = max(3, int(kernel_size))
    if kernel_size % 2 == 0:
        kernel_size += 1

    radius = kernel_size // 2
    coords = torch.arange(kernel_size, device=image.device, dtype=image.dtype) - radius
    kernel_1d = torch.exp(-(coords ** 2) / (2 * sigma ** 2))
    kernel_1d = kernel_1d / kernel_1d.sum()
    kernel_2d = torch.outer(kernel_1d, kernel_1d).view(1, 1, kernel_size, kernel_size)

    image_ch = image.permute(0, 3, 1, 2).contiguous()
    channels = image_ch.shape[1]
    kernel = kernel_2d.repeat(channels, 1, 1, 1)
    padded = torch_F.pad(image_ch, (radius, radius, radius, radius), mode="replicate")
    blurred = torch_F.conv2d(padded, kernel, groups=channels)
    return blurred.permute(0, 2, 3, 1).contiguous()


def _depthwise_conv3x3(image: torch.Tensor, kernel: torch.Tensor) -> torch.Tensor:
    image_ch = image.permute(0, 3, 1, 2).contiguous()
    channels = image_ch.shape[1]
    padded = torch_F.pad(image_ch, (1, 1, 1, 1), mode="replicate")
    result = torch_F.conv2d(padded, _channel_kernel(kernel, channels, image), groups=channels)
    return result.permute(0, 2, 3, 1).contiguous()


def _match_image_size(image: torch.Tensor, reference: torch.Tensor) -> torch.Tensor:
    if image.shape[1:3] == reference.shape[1:3]:
        return reference
    return _resize_image(reference, image.shape[1], image.shape[2], "bilinear")


def _adain_transfer(content: torch.Tensor, style: torch.Tensor, eps: float = 1e-5) -> torch.Tensor:
    content_ch = content.permute(0, 3, 1, 2)
    style_ch = style.permute(0, 3, 1, 2)
    content_mean = content_ch.mean(dim=(2, 3), keepdim=True)
    content_std = content_ch.std(dim=(2, 3), keepdim=True).clamp(min=eps)
    style_mean = style_ch.mean(dim=(2, 3), keepdim=True)
    style_std = style_ch.std(dim=(2, 3), keepdim=True).clamp(min=eps)
    result = (content_ch - content_mean) / content_std * style_std + style_mean
    return result.permute(0, 2, 3, 1).contiguous()


def _lab_color_transfer(content: torch.Tensor, style: torch.Tensor) -> torch.Tensor:
    if cv2 is None:
        return _adain_transfer(content, style)

    outputs = []
    for i in range(content.shape[0]):
        content_np = (content[i].detach().cpu().numpy().clip(0.0, 1.0) * 255).astype(np.uint8)
        style_np = (style[min(i, style.shape[0] - 1)].detach().cpu().numpy().clip(0.0, 1.0) * 255).astype(np.uint8)
        content_lab = cv2.cvtColor(content_np, cv2.COLOR_RGB2LAB).astype(np.float32)
        style_lab = cv2.cvtColor(style_np, cv2.COLOR_RGB2LAB).astype(np.float32)
        c_mean, c_std = cv2.meanStdDev(content_lab)
        s_mean, s_std = cv2.meanStdDev(style_lab)
        c_mean = c_mean.reshape(1, 1, 3)
        c_std = c_std.reshape(1, 1, 3)
        s_mean = s_mean.reshape(1, 1, 3)
        s_std = s_std.reshape(1, 1, 3)
        transferred = (content_lab - c_mean) / np.maximum(c_std, 1e-5) * np.maximum(s_std, 1e-5) + s_mean
        transferred = np.clip(transferred, 0, 255).astype(np.uint8)
        rgb = cv2.cvtColor(transferred, cv2.COLOR_LAB2RGB).astype(np.float32) / 255.0
        outputs.append(torch.from_numpy(rgb).to(device=content.device, dtype=content.dtype))
    return torch.stack(outputs, dim=0).contiguous()


def concatenate_images_horizontally(images: list, labels: list = None, font_size: int = 40, border: int = 32, label_height: int = 80, spacing: int = 20) -> torch.Tensor:
    if not images:
        return None
    target_height = images[0].shape[1]
    resized = []
    for img in images:
        if img.shape[1] != target_height:
            target_width = max(1, int(img.shape[2] * target_height / img.shape[1]))
            img = _resize_image(img, target_height, target_width, "bilinear")
        resized.append(img)
    if spacing > 0:
        gap = torch.ones((1, target_height, spacing, 3), dtype=torch.float32, device=images[0].device)
        final_list = []
        for i, img in enumerate(resized):
            final_list.append(img)
            if i < len(resized) - 1:
                final_list.append(gap)
        concat_image = torch.cat(final_list, dim=2)
    else:
        concat_image = torch.cat(resized, dim=2)
    if not labels or len(labels) == 0:
        return concat_image
    B, H, W, C = concat_image.shape
    np_img = (concat_image[0] * 255).clamp(0, 255).to(torch.uint8).cpu().numpy()
    pil_img = Image.fromarray(np_img)
    new_img = Image.new("RGB", (W, H + label_height), (255, 255, 255))
    new_img.paste(pil_img, (0, 0))
    draw = ImageDraw.Draw(new_img)
    try:
        font = ImageFont.truetype("C:/Windows/Fonts/msyh.ttc", font_size)
    except Exception:
        font = ImageFont.load_default()
    sub_width = W // len(labels)
    for i, text in enumerate(labels):
        x = i * sub_width + sub_width // 2
        draw.text((x, H + label_height // 2), text, fill=(255, 255, 255), font=font, anchor="mm", stroke_width=4, stroke_fill=(255, 255, 255))
        draw.text((x, H + label_height // 2), text, fill=(0, 0, 0), font=font, anchor="mm")
    final_np = np.array(new_img).astype(np.float32) / 255.0
    return torch.from_numpy(final_np).unsqueeze(0)


class GGRGBAtoRGB:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "图像": ("IMAGE",),
                "背景颜色": (["白色", "黑色", "灰色", "自定义"], {"default": "白色"}),
            },
            "optional": {
                "背景R": ("FLOAT", {"default": 1.0, "min": 0.0, "max": 1.0, "step": 0.01, "round": 0.001}),
                "背景G": ("FLOAT", {"default": 1.0, "min": 0.0, "max": 1.0, "step": 0.01, "round": 0.001}),
                "背景B": ("FLOAT", {"default": 1.0, "min": 0.0, "max": 1.0, "step": 0.01, "round": 0.001}),
            }
        }

    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("图像",)
    FUNCTION = "convert"
    CATEGORY = "GuliNodes/图像工具"

    def convert(self, 图像: torch.Tensor, 背景颜色: str = "白色", 背景R: float = 1.0, 背景G: float = 1.0, 背景B: float = 1.0) -> tuple:
        if 图像 is None:
            return (_empty_image(),)
        if 图像.shape[-1] == 1:
            return (图像.expand(*图像.shape[:-1], 3).contiguous(),)
        if 图像.shape[-1] == 2:
            gray = 图像[..., :1].expand(*图像.shape[:-1], 3)
            alpha = 图像[..., 1:2].clamp(0.0, 1.0)
            background = self._background(图像, 背景颜色, 背景R, 背景G, 背景B)
            return (torch.clamp(gray * alpha + background * (1.0 - alpha), 0.0, 1.0).contiguous(),)
        if 图像.shape[-1] == 3:
            return (图像,)
        if 图像.shape[-1] >= 4:
            rgb = 图像[..., :3]
            alpha = 图像[..., 3:4].clamp(0.0, 1.0)
            background = self._background(图像, 背景颜色, 背景R, 背景G, 背景B)
            return (torch.clamp(rgb * alpha + background * (1.0 - alpha), 0.0, 1.0).contiguous(),)
        return (_empty_image(图像.device, 图像.dtype),)

    @staticmethod
    def _background(图像: torch.Tensor, 背景颜色: str, 背景R: float, 背景G: float, 背景B: float) -> torch.Tensor:
        presets = {
            "白色": (1.0, 1.0, 1.0),
            "黑色": (0.0, 0.0, 0.0),
            "灰色": (0.5, 0.5, 0.5),
        }
        color = presets.get(背景颜色, (背景R, 背景G, 背景B))
        return torch.tensor(color, device=图像.device, dtype=图像.dtype).view(1, 1, 1, 3)


class GGImageResize:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "图像": ("IMAGE",),
                "模式": (["按比例", "按尺寸"], {"default": "按比例"}),
            },
            "optional": {
                "缩放比例": ("FLOAT", {"default": 1.0, "min": 0.1, "max": 10.0, "step": 0.1}),
                "宽度": ("INT", {"default": 512, "min": 64, "max": 4096, "step": 8}),
                "高度": ("INT", {"default": 512, "min": 64, "max": 4096, "step": 8}),
                "插值方法": (["bilinear", "nearest", "bicubic"], {"default": "bilinear"}),
            }
        }

    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("图像",)
    FUNCTION = "resize"
    CATEGORY = "GuliNodes/图像工具"

    def resize(self, 图像: torch.Tensor, 模式: str = "按比例", 缩放比例: float = 1.0,
               宽度: int = 512, 高度: int = 512, 插值方法: str = "bilinear") -> tuple:
        if 图像 is None:
            return (_empty_image(),)

        if 模式 == "按比例":
            new_height = int(图像.shape[1] * 缩放比例)
            new_width = int(图像.shape[2] * 缩放比例)
        else:
            new_height = 高度
            new_width = 宽度

        new_width = _align_to_eight(new_width)
        new_height = _align_to_eight(new_height)

        if 插值方法 == "nearest":
            mode = "nearest"
        elif 插值方法 == "bicubic":
            mode = "bicubic"
        else:
            mode = "bilinear"

        return (_resize_image(图像, new_height, new_width, mode),)


class GGImageCrop:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "图像": ("IMAGE",),
                "模式": (["中心裁剪", "手动裁剪", "按比例裁剪"], {"default": "中心裁剪"}),
            },
            "optional": {
                "宽度": ("INT", {"default": 512, "min": 64, "max": 4096, "step": 8}),
                "高度": ("INT", {"default": 512, "min": 64, "max": 4096, "step": 8}),
                "X坐标": ("INT", {"default": 0, "min": 0, "max": 4096, "step": 8}),
                "Y坐标": ("INT", {"default": 0, "min": 0, "max": 4096, "step": 8}),
                "宽高比例": (["1:1", "3:2", "4:3", "5:4", "16:9", "21:9", "9:16", "2:3", "3:4", "4:5", "9:21"], {"default": "16:9"}),
                "边长": ("INT", {"default": 1024, "min": 64, "max": 8192, "step": 8}),
                "边长类型": (["最长边", "最短边"], {"default": "最长边"}),
            }
        }

    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("图像",)
    FUNCTION = "crop"
    CATEGORY = "GuliNodes/图像工具"

    def crop(self, 图像: torch.Tensor, 模式: str = "中心裁剪",
              宽度: int = 512, 高度: int = 512, X坐标: int = 0, Y坐标: int = 0,
              宽高比例: str = "16:9", 边长: int = 1024, 边长类型: str = "最长边") -> tuple:
        if 图像 is None:
            return (_empty_image(),)

        if 模式 == "按比例裁剪":
            aspect_presets = {"1:1": (1, 1), "3:2": (3, 2), "4:3": (4, 3), "5:4": (5, 4), "16:9": (16, 9),
                           "21:9": (21, 9), "9:16": (9, 16), "2:3": (2, 3), "3:4": (3, 4), "4:5": (4, 5), "9:21": (9, 21)}

            wr, hr = aspect_presets[宽高比例]
            if 边长类型 == "最长边":
                crop_width = 边长 if wr > hr else int(边长 * wr / hr)
                crop_height = int(边长 * hr / wr) if wr > hr else 边长
            else:
                crop_height = 边长 if wr > hr else int(边长 * hr / wr)
                crop_width = int(边长 * wr / hr) if wr > hr else 边长

            crop_width = _align_to_eight(crop_width)
            crop_height = _align_to_eight(crop_height)

            img_height, img_width = 图像.shape[1], 图像.shape[2]
            x = (img_width - crop_width) // 2
            y = (img_height - crop_height) // 2

            x = max(0, x)
            y = max(0, y)

            crop_width = min(crop_width, img_width - x)
            crop_height = min(crop_height, img_height - y)

            cropped = 图像[:, y:y+crop_height, x:x+crop_width, :]
            return (cropped,)

        elif 模式 == "中心裁剪":
            img_height, img_width = 图像.shape[1], 图像.shape[2]
            x = (img_width - 宽度) // 2
            y = (img_height - 高度) // 2
        else:
            x = X坐标
            y = Y坐标

        x = max(0, x)
        y = max(0, y)

        img_height, img_width = 图像.shape[1], 图像.shape[2]
        width = min(宽度, img_width - x)
        height = min(高度, img_height - y)

        cropped = 图像[:, y:y+height, x:x+width, :]
        return (cropped,)


class GGImageTransform:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "图像": ("IMAGE",),
                "变换类型": (["水平翻转", "垂直翻转", "旋转90度", "旋转180度", "旋转270度"], {"default": "水平翻转"}),
            }
        }

    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("图像",)
    FUNCTION = "transform"
    CATEGORY = "GuliNodes/图像工具"

    def transform(self, 图像: torch.Tensor, 变换类型: str = "水平翻转") -> tuple:
        if 图像 is None:
            return (_empty_image(),)

        if 变换类型 == "水平翻转":
            return (torch.flip(图像, [2]),)
        elif 变换类型 == "垂直翻转":
            return (torch.flip(图像, [1]),)
        elif 变换类型 == "旋转90度":
            return (torch.rot90(图像, 1, [1, 2]),)
        elif 变换类型 == "旋转180度":
            return (torch.rot90(图像, 2, [1, 2]),)
        elif 变换类型 == "旋转270度":
            return (torch.rot90(图像, 3, [1, 2]),)
        else:
            return (图像,)


class GGImageAdjust:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "图像": ("IMAGE",),
            },
            "optional": {
                "亮度": ("FLOAT", {"default": 1.0, "min": 0.0, "max": 5.0, "step": 0.1, "round": 0.01}),
                "对比度": ("FLOAT", {"default": 1.1, "min": 0.0, "max": 5.0, "step": 0.1, "round": 0.01}),
                "饱和度": ("FLOAT", {"default": 1.0, "min": 0.0, "max": 5.0, "step": 0.1, "round": 0.01}),
                "锐化": ("FLOAT", {"default": 1.2, "min": 0.0, "max": 10.0, "step": 0.1, "round": 0.01}),
                "虚化": ("FLOAT", {"default": 0.0, "min": 0.0, "max": 20.0, "step": 0.1, "round": 0.01}),
            }
        }

    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("图像",)
    FUNCTION = "adjust"
    CATEGORY = "GuliNodes/图像工具"

    def adjust(self, 图像: torch.Tensor, 亮度: float = 1.0,
               对比度: float = 1.0, 饱和度: float = 1.0, 锐化: float = 1.0, 虚化: float = 0.0) -> tuple:
        if 图像 is None:
            return (_empty_image(),)

        adjusted = 图像 * 亮度
        adjusted = (adjusted - 0.5) * 对比度 + 0.5

        if 饱和度 != 1.0:
            gray = adjusted.mean(dim=-1, keepdim=True)
            adjusted = gray * (1 - 饱和度) + adjusted * 饱和度

        if 虚化 > 0:
            adjusted = _gaussian_blur(adjusted, sigma=虚化)

        if 锐化 > 0:
            blur_sigma = max(0.5, min(float(锐化) * 0.6, 4.0))
            blurred = _gaussian_blur(adjusted, sigma=blur_sigma)
            adjusted = adjusted + (adjusted - blurred) * float(锐化)

        adjusted = torch.clamp(adjusted, 0.0, 1.0)

        return (adjusted,)


class GGFaceSkinSmoothing:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "图像": ("IMAGE",),
            },
            "optional": {
                "平滑": ("INT", {"default": 8, "min": 1, "max": 100, "step": 1}),
                "阈值": ("INT", {"default": -10, "min": -100, "max": 100, "step": 1}),
                "不透明度": ("INT", {"default": 85, "min": 0, "max": 100, "step": 1}),
                "脸部扩展": ("FLOAT", {"default": 1.2, "min": 0.8, "max": 2.0, "step": 0.05, "round": 0.01}),
            }
        }

    RETURN_TYPES = ("IMAGE", "MASK")
    RETURN_NAMES = ("图像", "磨皮遮罩")
    FUNCTION = "smooth"
    CATEGORY = "GuliNodes/图像工具"

    def smooth(self, 图像: torch.Tensor, 平滑: int = 8, 阈值: int = -10, 不透明度: int = 85, 脸部扩展: float = 1.2) -> tuple:
        image = _to_rgb_image(图像)
        if cv2 is None or image is None:
            return (image, torch.zeros(image.shape[0], image.shape[1], image.shape[2], device=image.device, dtype=image.dtype))

        output_images = []
        output_masks = []
        opacity = max(0.0, min(float(不透明度) / 100.0, 1.0))
        strength = max(1, int(平滑))
        detail_threshold = max(0.0, min((float(阈值) + 100.0) / 200.0, 1.0))

        for batch_index in range(image.shape[0]):
            source = image[batch_index].detach().cpu().numpy()
            source_u8 = (np.clip(source, 0.0, 1.0) * 255.0).astype(np.uint8)
            analysis = _build_face_analysis_context(source_u8, sensitivity=60)
            faces = _detect_faces_robust(source_u8, sensitivity=60, include_profile=True, context=analysis)
            face_mask_u8 = self._detect_face_mask(source_u8, faces, 脸部扩展, context=analysis)

            if face_mask_u8.max() == 0 or opacity <= 0 or not faces:
                output_images.append(image[batch_index])
                output_masks.append(torch.zeros(image.shape[1], image.shape[2], device=image.device, dtype=image.dtype))
                continue

            smooth_u8 = self._smooth_image(source_u8, strength)
            mask_float = GGFaceSmartBeauty._smoothing_skin_mask(source_u8, face_mask_u8, faces, context=analysis)
            if detail_threshold > 0:
                diff = np.mean(np.abs(source_u8.astype(np.float32) - smooth_u8.astype(np.float32)), axis=2)
                protect = np.clip(diff / max(1.0, detail_threshold * 80.0), 0.0, 1.0)
                mask_float = np.clip(mask_float * (1.0 - protect * 0.65), 0.0, 1.0)

            mask_float = np.clip(mask_float * opacity, 0.0, 1.0)
            blended = source_u8.astype(np.float32) * (1.0 - mask_float[..., None]) + smooth_u8.astype(np.float32) * mask_float[..., None]
            blended = np.clip(blended, 0.0, 255.0).astype(np.uint8)
            output_images.append(torch.from_numpy(blended.astype(np.float32) / 255.0).to(device=image.device, dtype=image.dtype))
            output_masks.append(torch.from_numpy(mask_float.astype(np.float32)).to(device=image.device, dtype=image.dtype))

        return (torch.stack(output_images, dim=0).contiguous(), torch.stack(output_masks, dim=0).contiguous())

    @staticmethod
    def _detect_face_mask(image_u8: np.ndarray, faces: list, expansion: float, context: dict[str, Any] | None = None) -> np.ndarray:
        gray = cv2.cvtColor(image_u8, cv2.COLOR_RGB2GRAY)
        return _build_face_mask(image_u8.shape[:2], faces, expansion=expansion, vertical_scale=1.15, blur_sigma=12.0, gray=gray, sensitivity=60, image_u8=image_u8, context=context)

    @staticmethod
    def _smooth_image(image_u8: np.ndarray, strength: int) -> np.ndarray:
        diameter = max(5, min(31, int(strength / 3) * 2 + 1))
        sigma_color = max(20, min(150, strength * 3))
        sigma_space = max(5, min(80, strength))
        smooth = cv2.bilateralFilter(image_u8, diameter, sigma_color, sigma_space)
        blur = cv2.GaussianBlur(smooth, (0, 0), sigmaX=max(0.1, strength / 18.0))
        return cv2.addWeighted(smooth, 0.75, blur, 0.25, 0)


class GGFaceSmartBeauty:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {"图像": ("IMAGE",)},
            "optional": {
                "自动磨皮": ("INT", {"default": 0, "min": 0, "max": 100, "step": 1}),
                "自动美白皮肤": ("INT", {"default": 0, "min": 0, "max": 100, "step": 1}),
                "眼白提亮": ("INT", {"default": 0, "min": 0, "max": 100, "step": 1}),
                "眼睛大小": ("INT", {"default": 0, "min": -50, "max": 100, "step": 1}),
                "牙齿美白": ("INT", {"default": 0, "min": 0, "max": 100, "step": 1}),
                "自动瘦脸": ("INT", {"default": 0, "min": 0, "max": 100, "step": 1}),
                "脸部扩展": ("FLOAT", {"default": 1.35, "min": 0.8, "max": 2.0, "step": 0.05, "round": 0.01}),
                "检测灵敏度": ("INT", {"default": 45, "min": 0, "max": 100, "step": 1}),
            },
        }

    RETURN_TYPES = ("IMAGE", "MASK")
    RETURN_NAMES = ("图像", "人脸遮罩")
    FUNCTION = "beautify"
    CATEGORY = "GuliNodes/图像工具"

    def beautify(self, **kwargs) -> tuple:
        image = _to_rgb_image(kwargs.get("图像"))
        if cv2 is None or image is None:
            empty_mask = torch.zeros(image.shape[0], image.shape[1], image.shape[2], device=image.device, dtype=image.dtype)
            return (image, empty_mask)

        skin_strength = float(kwargs.get("自动磨皮", 0)) / 100.0
        whitening_strength = float(kwargs.get("自动美白皮肤", 0)) / 100.0
        eye_white_strength = float(kwargs.get("眼白提亮", 0)) / 100.0
        eye_scale = float(kwargs.get("眼睛大小", 0)) / 100.0
        teeth_strength = float(kwargs.get("牙齿美白", 0)) / 100.0
        slim_strength = float(kwargs.get("自动瘦脸", 0)) / 100.0
        expansion = float(kwargs.get("脸部扩展", 1.35))
        sensitivity = int(kwargs.get("检测灵敏度", 45))

        outputs = []
        masks = []
        for batch_index in range(image.shape[0]):
            source = image[batch_index].detach().cpu().numpy()
            source_u8 = (np.clip(source, 0.0, 1.0) * 255.0).astype(np.uint8)
            analysis = _build_face_analysis_context(source_u8, sensitivity=sensitivity)
            faces = self._detect_faces(source_u8, sensitivity, context=analysis)
            face_mask = self._face_mask(source_u8, faces, expansion, context=analysis)
            if not faces or face_mask.max() == 0:
                outputs.append(image[batch_index])
                masks.append(torch.zeros(image.shape[1], image.shape[2], device=image.device, dtype=image.dtype))
                continue

            result = source_u8.copy()
            if slim_strength > 0:
                previous_faces = faces
                previous_face_mask = face_mask
                result = self._slim_faces(result, faces, slim_strength, context=analysis)
                analysis = _build_face_analysis_context(result, sensitivity=sensitivity)
                updated_faces = self._detect_faces(result, sensitivity, context=analysis)
                updated_face_mask = self._face_mask(result, updated_faces, expansion, context=analysis)
                if updated_faces and updated_face_mask.max() > 0:
                    faces = updated_faces
                    face_mask = updated_face_mask
                else:
                    faces = previous_faces
                    face_mask = previous_face_mask
            if skin_strength > 0:
                result = self._smooth_skin(result, face_mask, faces, skin_strength, context=analysis)
            if whitening_strength > 0:
                result = self._whiten_skin(result, face_mask, faces, whitening_strength, context=analysis)
            if eye_white_strength > 0 or abs(eye_scale) > 0.001:
                result = self._enhance_eyes(result, faces, eye_white_strength, eye_scale, sensitivity, context=analysis)
            if teeth_strength > 0:
                result = self._whiten_teeth(result, faces, teeth_strength, context=analysis)

            outputs.append(torch.from_numpy(result.astype(np.float32) / 255.0).to(device=image.device, dtype=image.dtype))
            masks.append(torch.from_numpy(face_mask.astype(np.float32) / 255.0).to(device=image.device, dtype=image.dtype))
        return (torch.stack(outputs, dim=0).contiguous(), torch.stack(masks, dim=0).contiguous())

    @staticmethod
    def _detect_faces(image_u8: np.ndarray, sensitivity: int, context: dict[str, Any] | None = None) -> list:
        return _detect_faces_robust(image_u8, sensitivity=sensitivity, include_profile=True, context=context)

    @staticmethod
    def _face_mask(image_u8: np.ndarray, faces: list, expansion: float, context: dict[str, Any] | None = None) -> np.ndarray:
        gray = cv2.cvtColor(image_u8, cv2.COLOR_RGB2GRAY)
        return _build_face_mask(image_u8.shape[:2], faces, expansion=expansion, vertical_scale=1.15, blur_sigma=10.0, gray=gray, sensitivity=60, image_u8=image_u8, context=context)

    @classmethod
    def _facial_feature_protect_mask(
        cls,
        image_u8: np.ndarray,
        faces: list,
        protect_nose: bool = True,
        eye_scale_x: float = 0.43,
        eye_scale_y: float = 0.13,
        mouth_scale_x: float = 0.33,
        mouth_scale_y: float = 0.15,
        nose_scale_x: float = 0.18,
        nose_scale_y: float = 0.22,
        eye_strength: float = 1.0,
        mouth_strength: float = 1.0,
        nose_strength: float = 0.95,
        context: dict[str, Any] | None = None,
    ) -> np.ndarray:
        height, width = image_u8.shape[:2]
        protect = np.zeros((height, width), dtype=np.float32)
        gray = context.get("gray") if context is not None else cv2.cvtColor(image_u8, cv2.COLOR_RGB2GRAY)
        mesh_results = context.get("mesh_results", []) if context is not None else _get_mediapipe_face_meshes(image_u8)
        mesh_indices = context.get("mesh_indices", _get_face_mesh_index_sets()) if context is not None else _get_face_mesh_index_sets()
        for face in faces:
            x, y, w, h = face
            cx = x + w / 2.0
            shift, profile_strength = _analyze_face_pose(gray, face, sensitivity=60, image_u8=image_u8, context=context)
            cx = cx + shift * w * 0.06
            eye_y = y + h * 0.38
            nose_y = y + h * 0.54
            mouth_y = y + h * 0.74
            mouth_region = _detect_mouth_region(image_u8, face, context=context)
            mesh_match = _match_mediapipe_mesh(face, mesh_results)
            cv2.ellipse(
                protect,
                (int(cx), int(eye_y)),
                (max(1, int(w * (eye_scale_x - profile_strength * 0.05))), max(1, int(h * eye_scale_y))),
                0,
                0,
                360,
                float(eye_strength),
                -1,
            )
            if mesh_match is not None:
                landmarks = mesh_match.get("landmarks")
                _fill_landmark_region(protect, landmarks, mesh_indices.get("left_eye", []), float(eye_strength))
                _fill_landmark_region(protect, landmarks, mesh_indices.get("right_eye", []), float(eye_strength))
                _fill_landmark_region(protect, landmarks, mesh_indices.get("left_eyebrow", []), float(eye_strength * 0.85))
                _fill_landmark_region(protect, landmarks, mesh_indices.get("right_eyebrow", []), float(eye_strength * 0.85))
            if protect_nose:
                cv2.ellipse(
                    protect,
                    (int(cx), int(nose_y)),
                    (max(1, int(w * (nose_scale_x + profile_strength * 0.03))), max(1, int(h * nose_scale_y))),
                    0,
                    0,
                    360,
                    float(nose_strength),
                    -1,
                )
            if mouth_region is not None:
                mx, my, mw, mh = mouth_region
                mouth_center = (int(mx + mw * 0.5), int(my + mh * 0.5))
                mouth_axes = (max(1, int(mw * 0.68)), max(1, int(mh * 0.95)))
                cv2.ellipse(protect, mouth_center, mouth_axes, 0, 0, 360, float(mouth_strength), -1)
            else:
                cv2.ellipse(
                    protect,
                    (int(cx), int(mouth_y)),
                    (max(1, int(w * mouth_scale_x)), max(1, int(h * mouth_scale_y))),
                    0,
                    0,
                    360,
                    float(mouth_strength),
                    -1,
                )
            if mesh_match is not None:
                _fill_landmark_region(protect, mesh_match.get("landmarks"), mesh_indices.get("lips", []), float(mouth_strength))
            for ex, ey, ew, eh in _detect_eyes_robust(gray, face, 60):
                cv2.ellipse(protect, (ex + ew // 2, ey + eh // 2), (max(1, int(ew * 0.82)), max(1, int(eh * 0.72))), 0, 0, 360, 1.0, -1)
        if protect.max() > 0:
            protect = cv2.GaussianBlur(protect, (0, 0), sigmaX=4.0, sigmaY=4.0)
        return np.clip(protect, 0.0, 1.0)


    @classmethod
    def _protected_skin_mask(cls, image_u8: np.ndarray, face_mask: np.ndarray, faces: list, fallback_to_face: bool = True, context: dict[str, Any] | None = None) -> np.ndarray:
        skin_mask = cls._skin_color_mask(image_u8, face_mask)
        if skin_mask.max() == 0 and fallback_to_face:
            skin_mask = face_mask.astype(np.float32) / 255.0
        protect = cls._facial_feature_protect_mask(image_u8, faces, context=context)
        mask = skin_mask * (1.0 - protect)
        if mask.max() > 0:
            mask = cv2.GaussianBlur(mask.astype(np.float32), (0, 0), sigmaX=2.0, sigmaY=2.0)
        return np.clip(mask, 0.0, 1.0)

    @classmethod
    def _smoothing_priority_mask(cls, image_u8: np.ndarray, faces: list, context: dict[str, Any] | None = None) -> np.ndarray:
        height, width = image_u8.shape[:2]
        priority = np.zeros((height, width), dtype=np.float32)
        suppress = np.zeros((height, width), dtype=np.float32)
        gray = context.get("gray") if context is not None else cv2.cvtColor(image_u8, cv2.COLOR_RGB2GRAY)
        mesh_results = context.get("mesh_results", []) if context is not None else _get_mediapipe_face_meshes(image_u8)
        mesh_indices = context.get("mesh_indices", _get_face_mesh_index_sets()) if context is not None else _get_face_mesh_index_sets()
        for x, y, w, h in faces:
            cx = x + w / 2.0
            shift, profile_strength = _analyze_face_pose(gray, (x, y, w, h), sensitivity=60, image_u8=image_u8, context=context)
            cheek_offset = w * (0.22 - profile_strength * 0.04)
            left_cheek = (int(cx - cheek_offset + shift * w * 0.04), int(y + h * 0.57))
            right_cheek = (int(cx + cheek_offset + shift * w * 0.04), int(y + h * 0.57))
            cheek_axes = (max(1, int(w * 0.20)), max(1, int(h * 0.23)))
            temple_offset = w * (0.24 - profile_strength * 0.03)
            left_temple = (int(cx - temple_offset + shift * w * 0.03), int(y + h * 0.34))
            right_temple = (int(cx + temple_offset + shift * w * 0.03), int(y + h * 0.34))
            temple_axes = (max(1, int(w * 0.13)), max(1, int(h * 0.15)))
            left_temple_bridge = (int((left_temple[0] + left_cheek[0]) * 0.5), int((left_temple[1] + left_cheek[1]) * 0.5))
            right_temple_bridge = (int((right_temple[0] + right_cheek[0]) * 0.5), int((right_temple[1] + right_cheek[1]) * 0.5))
            temple_bridge_axes = (max(1, int(w * 0.10)), max(1, int(h * 0.16)))
            left_forehead = (int(cx - w * 0.16 + shift * w * 0.03), int(y + h * 0.20))
            right_forehead = (int(cx + w * 0.16 + shift * w * 0.03), int(y + h * 0.20))
            forehead_axes = (max(1, int(w * 0.11)), max(1, int(h * 0.10)))
            forehead_band = (int(cx + shift * w * 0.03), int(y + h * 0.24))
            forehead_band_axes = (max(1, int(w * 0.18)), max(1, int(h * 0.08)))
            nose_center = (int(cx + shift * w * 0.08), int(y + h * 0.55))
            nose_axes = (max(1, int(w * (0.08 + profile_strength * 0.03))), max(1, int(h * 0.25)))
            chin_center = (int(cx + shift * w * 0.04), int(y + h * 0.86))
            chin_axes = (max(1, int(w * (0.18 - profile_strength * 0.02))), max(1, int(h * 0.12)))
            left_jaw = (int(cx - w * (0.20 - profile_strength * 0.03) + shift * w * 0.04), int(y + h * 0.79))
            right_jaw = (int(cx + w * (0.20 - profile_strength * 0.03) + shift * w * 0.04), int(y + h * 0.79))
            jaw_axes = (max(1, int(w * 0.12)), max(1, int(h * 0.12)))
            philtrum_center = (int(cx + shift * w * 0.05), int(y + h * 0.70))
            philtrum_axes = (max(1, int(w * 0.14)), max(1, int(h * 0.10)))
            chin_mouth_center = (int(cx + shift * w * 0.05), int(y + h * 0.79))
            chin_mouth_axes = (max(1, int(w * (0.28 - profile_strength * 0.04))), max(1, int(h * 0.11)))
            mesh_match = _match_mediapipe_mesh((x, y, w, h), mesh_results)

            if mesh_match is not None:
                landmarks = mesh_match.get("landmarks")
                face_area = np.zeros((height, width), dtype=np.float32)
                _fill_landmark_region(face_area, landmarks, mesh_indices.get("oval", []), 1.0)
                feature_holes = np.zeros((height, width), dtype=np.float32)
                _fill_landmark_region(feature_holes, landmarks, mesh_indices.get("left_eye", []), 1.0)
                _fill_landmark_region(feature_holes, landmarks, mesh_indices.get("right_eye", []), 1.0)
                _fill_landmark_region(feature_holes, landmarks, mesh_indices.get("left_eyebrow", []), 0.8)
                _fill_landmark_region(feature_holes, landmarks, mesh_indices.get("right_eyebrow", []), 0.8)
                _fill_landmark_region(feature_holes, landmarks, mesh_indices.get("lips", []), 1.0)
                face_area = np.clip(face_area - np.clip(feature_holes, 0.0, 1.0), 0.0, 1.0)
                if face_area.max() > 0:
                    face_area = cv2.GaussianBlur(face_area, (0, 0), sigmaX=3.0, sigmaY=3.0)
                    priority = np.maximum(priority, face_area * 0.82)

            cv2.ellipse(priority, left_cheek, cheek_axes, 18, 0, 360, 0.95, -1)
            cv2.ellipse(priority, right_cheek, cheek_axes, -18, 0, 360, 0.95, -1)
            cv2.ellipse(priority, left_temple, temple_axes, 8, 0, 360, 0.68, -1)
            cv2.ellipse(priority, right_temple, temple_axes, -8, 0, 360, 0.68, -1)
            cv2.ellipse(priority, left_temple_bridge, temple_bridge_axes, 12, 0, 360, 0.64, -1)
            cv2.ellipse(priority, right_temple_bridge, temple_bridge_axes, -12, 0, 360, 0.64, -1)
            cv2.ellipse(priority, left_forehead, forehead_axes, 6, 0, 360, 0.40, -1)
            cv2.ellipse(priority, right_forehead, forehead_axes, -6, 0, 360, 0.40, -1)
            cv2.ellipse(priority, forehead_band, forehead_band_axes, 0, 0, 360, 0.34, -1)
            cv2.ellipse(priority, nose_center, nose_axes, 0, 0, 360, 0.72, -1)
            cv2.ellipse(priority, chin_center, chin_axes, 0, 0, 360, 0.70, -1)
            cv2.ellipse(priority, left_jaw, jaw_axes, 10, 0, 360, 0.62, -1)
            cv2.ellipse(priority, right_jaw, jaw_axes, -10, 0, 360, 0.62, -1)
            cv2.ellipse(suppress, philtrum_center, philtrum_axes, 0, 0, 360, 0.82, -1)
            cv2.ellipse(suppress, chin_mouth_center, chin_mouth_axes, 0, 0, 360, 0.95, -1)

        if priority.max() > 0:
            priority = cv2.GaussianBlur(priority, (0, 0), sigmaX=4.2, sigmaY=4.2)
        if suppress.max() > 0:
            suppress = cv2.GaussianBlur(suppress, (0, 0), sigmaX=3.2, sigmaY=3.2)
        return np.clip(priority * (1.0 - np.clip(suppress, 0.0, 1.0)), 0.0, 1.0)

    @classmethod
    def _smoothing_skin_mask(cls, image_u8: np.ndarray, face_mask: np.ndarray, faces: list, context: dict[str, Any] | None = None) -> np.ndarray:
        base_face = face_mask.astype(np.float32) / 255.0
        skin_mask = cls._skin_color_mask(image_u8, face_mask)
        if skin_mask.max() == 0:
            skin_mask = base_face
        else:
            skin_mask = np.clip(np.maximum(skin_mask, base_face * 0.52), 0.0, 1.0)

        priority = cls._smoothing_priority_mask(image_u8, faces, context=context)
        skin_mask = np.clip(np.maximum(skin_mask, priority * 0.92 + base_face * 0.18), 0.0, 1.0)

        protect = cls._facial_feature_protect_mask(
            image_u8,
            faces,
            protect_nose=False,
            eye_scale_x=0.40,
            eye_scale_y=0.11,
            mouth_scale_x=0.29,
            mouth_scale_y=0.11,
            eye_strength=0.95,
            mouth_strength=0.80,
            context=context,
        )
        mask = skin_mask * (1.0 - protect)
        if mask.max() > 0:
            mask = cv2.GaussianBlur(mask.astype(np.float32), (0, 0), sigmaX=2.8, sigmaY=2.8)
        return np.clip(mask, 0.0, 1.0)

    @classmethod
    def _smooth_skin(cls, image_u8: np.ndarray, face_mask: np.ndarray, faces: list, strength: float, context: dict[str, Any] | None = None) -> np.ndarray:
        diameter = max(5, int(7 + strength * 22) // 2 * 2 + 1)
        smooth = cv2.bilateralFilter(image_u8, diameter, 35 + strength * 110, 12 + strength * 55)
        blur = cv2.GaussianBlur(smooth, (0, 0), sigmaX=0.5 + strength * 1.8)
        smooth = cv2.addWeighted(smooth, 0.8, blur, 0.2, 0)
        mask = cls._smoothing_skin_mask(image_u8, face_mask, faces, context=context)
        mask = np.clip(mask * min(0.9, 0.18 + strength * 0.72), 0.0, 0.9)
        return np.clip(image_u8.astype(np.float32) * (1.0 - mask[..., None]) + smooth.astype(np.float32) * mask[..., None], 0, 255).astype(np.uint8)

    @staticmethod
    def _skin_color_mask(image_u8: np.ndarray, face_mask: np.ndarray) -> np.ndarray:
        ycrcb = cv2.cvtColor(image_u8, cv2.COLOR_RGB2YCrCb)
        cr = ycrcb[..., 1]
        cb = ycrcb[..., 2]
        skin = ((cr > 128) & (cr < 185) & (cb > 72) & (cb < 150) & (face_mask > 12)).astype(np.float32)
        if skin.max() > 0:
            skin = cv2.GaussianBlur(skin, (0, 0), sigmaX=3.4, sigmaY=3.4)
        return np.clip(skin, 0.0, 1.0)

    @classmethod
    def _whiten_skin(cls, image_u8: np.ndarray, face_mask: np.ndarray, faces: list, strength: float, context: dict[str, Any] | None = None) -> np.ndarray:
        skin = cls._protected_skin_mask(image_u8, face_mask, faces, context=context)
        if skin.max() == 0:
            return image_u8
        lab = cv2.cvtColor(image_u8, cv2.COLOR_RGB2LAB).astype(np.float32)
        lab[..., 0] = np.clip(lab[..., 0] + 28.0 * strength * skin, 0, 255)
        lab[..., 1] = np.clip(lab[..., 1] - 2.0 * strength * skin, 0, 255)
        lab[..., 2] = np.clip(lab[..., 2] - 4.0 * strength * skin, 0, 255)
        rgb = cv2.cvtColor(lab.astype(np.uint8), cv2.COLOR_LAB2RGB).astype(np.float32)
        hsv = cv2.cvtColor(rgb.astype(np.uint8), cv2.COLOR_RGB2HSV).astype(np.float32)
        hsv[..., 1] *= (1.0 - skin * strength * 0.22)
        white = cv2.cvtColor(hsv.astype(np.uint8), cv2.COLOR_HSV2RGB)
        alpha = np.clip(skin * (0.22 + strength * 0.68), 0.0, 0.88)
        return np.clip(image_u8.astype(np.float32) * (1.0 - alpha[..., None]) + white.astype(np.float32) * alpha[..., None], 0, 255).astype(np.uint8)

    @staticmethod
    def _detect_eyes(gray: np.ndarray, face: tuple, sensitivity: int) -> list:
        return _detect_eyes_robust(gray, face, sensitivity)

    @staticmethod
    def _local_scale(image_u8: np.ndarray, center: tuple, radius_x: int, radius_y: int, scale: float) -> np.ndarray:
        if abs(scale) < 0.001:
            return image_u8
        height, width = image_u8.shape[:2]
        cx, cy = center
        x1 = max(0, int(cx - radius_x)); y1 = max(0, int(cy - radius_y))
        x2 = min(width, int(cx + radius_x)); y2 = min(height, int(cy + radius_y))
        if x2 <= x1 + 2 or y2 <= y1 + 2:
            return image_u8
        roi = image_u8[y1:y2, x1:x2].copy()
        yy, xx = np.indices((y2 - y1, x2 - x1), dtype=np.float32)
        local_cx = cx - x1; local_cy = cy - y1
        nx = (xx - local_cx) / max(1.0, radius_x)
        ny = (yy - local_cy) / max(1.0, radius_y)
        dist = np.clip(nx * nx + ny * ny, 0.0, 1.0)
        weight = (1.0 - dist) ** 1.5
        factor = 1.0 + scale * weight
        map_x = local_cx + (xx - local_cx) / np.maximum(factor, 0.2)
        map_y = local_cy + (yy - local_cy) / np.maximum(factor, 0.2)
        warped = cv2.remap(roi, map_x.astype(np.float32), map_y.astype(np.float32), interpolation=cv2.INTER_LINEAR, borderMode=cv2.BORDER_REFLECT)
        alpha = (weight * min(1.0, abs(scale) * 1.5 + 0.25))[..., None]
        out = image_u8.copy()
        out[y1:y2, x1:x2] = np.clip(roi.astype(np.float32) * (1.0 - alpha) + warped.astype(np.float32) * alpha, 0, 255).astype(np.uint8)
        return out

    @staticmethod
    def _eye_white_mask(roi: np.ndarray) -> np.ndarray:
        if roi.size == 0:
            return np.zeros(roi.shape[:2], dtype=np.float32)
        height, width = roi.shape[:2]
        hsv = cv2.cvtColor(roi, cv2.COLOR_RGB2HSV).astype(np.float32)
        gray = cv2.cvtColor(roi, cv2.COLOR_RGB2GRAY).astype(np.float32)
        yy, xx = np.indices((height, width), dtype=np.float32)
        cx = (width - 1) / 2.0
        cy = (height - 1) / 2.0
        eye_shape = (((xx - cx) / max(1.0, width * 0.46)) ** 2 + ((yy - cy) / max(1.0, height * 0.34)) ** 2) <= 1.0
        low_saturation = hsv[..., 1] < 95
        bright_enough = hsv[..., 2] > max(55.0, float(np.percentile(hsv[..., 2], 35)))
        not_skin_ycrcb = cv2.cvtColor(roi, cv2.COLOR_RGB2YCrCb)
        cr = not_skin_ycrcb[..., 1]
        cb = not_skin_ycrcb[..., 2]
        skin_like = (cr > 135) & (cr < 180) & (cb > 75) & (cb < 145)
        iris_dark = gray < max(45.0, float(np.percentile(gray, 22)))
        iris_dark = cv2.dilate(iris_dark.astype(np.uint8), np.ones((3, 3), dtype=np.uint8), iterations=1).astype(bool)
        center_protect = (((xx - cx) / max(1.0, width * 0.18)) ** 2 + ((yy - cy) / max(1.0, height * 0.28)) ** 2) <= 1.0
        edge_protect = (yy < height * 0.18) | (yy > height * 0.82) | (xx < width * 0.05) | (xx > width * 0.95)
        mask = eye_shape & low_saturation & bright_enough & (~skin_like) & (~iris_dark) & (~center_protect) & (~edge_protect)
        if mask.sum() < max(4, int(width * height * 0.015)):
            mask = eye_shape & low_saturation & bright_enough & (~iris_dark) & (~edge_protect)
        mask = mask.astype(np.float32)
        if mask.max() > 0:
            mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN, np.ones((2, 2), dtype=np.uint8))
            mask = cv2.GaussianBlur(mask, (0, 0), sigmaX=1.1, sigmaY=1.1)
        return np.clip(mask, 0.0, 1.0)

    @classmethod
    def _enhance_eyes(
        cls,
        image_u8: np.ndarray,
        faces: list,
        white_strength: float,
        eye_scale: float,
        sensitivity: int,
        context: dict[str, Any] | None = None,
    ) -> np.ndarray:
        result = image_u8.copy()
        mesh_results = context.get("mesh_results", []) if context is not None else _get_mediapipe_face_meshes(result)
        gray = context.get("gray") if context is not None else cv2.cvtColor(result, cv2.COLOR_RGB2GRAY)
        for face in faces:
            mesh_match = _match_mediapipe_mesh(face, mesh_results)
            for ex, ey, ew, eh in cls._detect_eyes(gray, face, sensitivity):
                if abs(eye_scale) > 0.001:
                    result = cls._local_scale(result, (ex + ew // 2, ey + eh // 2), max(ew, 8), max(eh, 8), eye_scale * 0.45)
                if white_strength <= 0:
                    continue
                pad_x = max(1, int(ew * 0.08))
                pad_y = max(1, int(eh * 0.08))
                x1 = max(0, ex - pad_x)
                y1 = max(0, ey - pad_y)
                x2 = min(result.shape[1], ex + ew + pad_x)
                y2 = min(result.shape[0], ey + eh + pad_y)
                roi = result[y1:y2, x1:x2]
                if roi.size == 0:
                    continue
                white_mask = cls._eye_white_mask(roi)
                if white_mask.max() <= 0:
                    continue
                lab = cv2.cvtColor(roi, cv2.COLOR_RGB2LAB).astype(np.float32)
                hsv = cv2.cvtColor(roi, cv2.COLOR_RGB2HSV).astype(np.float32)
                lab[..., 0] = np.clip(lab[..., 0] + white_mask * white_strength * 32.0, 0, 255)
                enhanced = cv2.cvtColor(lab.astype(np.uint8), cv2.COLOR_LAB2RGB).astype(np.float32)
                enhanced_hsv = cv2.cvtColor(enhanced.astype(np.uint8), cv2.COLOR_RGB2HSV).astype(np.float32)
                enhanced_hsv[..., 1] = np.clip(hsv[..., 1] * (1.0 - white_mask * white_strength * 0.38), 0, 255)
                enhanced = cv2.cvtColor(enhanced_hsv.astype(np.uint8), cv2.COLOR_HSV2RGB)
                alpha = np.clip(white_mask * (0.25 + white_strength * 0.65), 0.0, 0.85)
                result[y1:y2, x1:x2] = np.clip(roi.astype(np.float32) * (1.0 - alpha[..., None]) + enhanced.astype(np.float32) * alpha[..., None], 0, 255).astype(np.uint8)
            if mesh_match is None or white_strength <= 0:
                continue
            landmarks = mesh_match.get("landmarks")
            for side in ("left", "right"):
                built = _build_eye_white_mask_from_mesh(landmarks, side, result.shape[:2])
                if built is None:
                    continue
                eye_bbox, white_mask = built
                if white_mask.max() <= 0:
                    continue
                x1, y1, w, h = eye_bbox
                x2 = x1 + w
                y2 = y1 + h
                roi = result[y1:y2, x1:x2]
                if roi.size == 0:
                    continue
                lab = cv2.cvtColor(roi, cv2.COLOR_RGB2LAB).astype(np.float32)
                hsv = cv2.cvtColor(roi, cv2.COLOR_RGB2HSV).astype(np.float32)
                lab[..., 0] = np.clip(lab[..., 0] + white_mask * white_strength * 36.0, 0, 255)
                enhanced = cv2.cvtColor(lab.astype(np.uint8), cv2.COLOR_LAB2RGB).astype(np.float32)
                enhanced_hsv = cv2.cvtColor(enhanced.astype(np.uint8), cv2.COLOR_RGB2HSV).astype(np.float32)
                enhanced_hsv[..., 1] = np.clip(hsv[..., 1] * (1.0 - white_mask * white_strength * 0.42), 0, 255)
                enhanced = cv2.cvtColor(enhanced_hsv.astype(np.uint8), cv2.COLOR_HSV2RGB)
                alpha = np.clip(white_mask * (0.22 + white_strength * 0.68), 0.0, 0.88)
                result[y1:y2, x1:x2] = np.clip(roi.astype(np.float32) * (1.0 - alpha[..., None]) + enhanced.astype(np.float32) * alpha[..., None], 0, 255).astype(np.uint8)
        return result

    @staticmethod
    def _tooth_mask(roi: np.ndarray, lips_mask: np.ndarray | None = None) -> np.ndarray:
        if roi.size == 0:
            return np.zeros(roi.shape[:2], dtype=np.float32)
        height, width = roi.shape[:2]
        hsv = cv2.cvtColor(roi, cv2.COLOR_RGB2HSV).astype(np.float32)
        ycrcb = cv2.cvtColor(roi, cv2.COLOR_RGB2YCrCb)
        cr = ycrcb[..., 1].astype(np.float32)
        cb = ycrcb[..., 2].astype(np.float32)
        yy, xx = np.indices((height, width), dtype=np.float32)
        cx = (width - 1) / 2.0
        cy = (height - 1) / 2.0
        mouth_ellipse = (((xx - cx) / max(1.0, width * 0.46)) ** 2 + ((yy - cy) / max(1.0, height * 0.34)) ** 2) <= 1.0
        if lips_mask is not None and lips_mask.shape[:2] == roi.shape[:2]:
            mouth_ellipse = mouth_ellipse & (lips_mask > 0.10)
        low_sat = hsv[..., 1] < 90
        bright = hsv[..., 2] > max(85.0, float(np.percentile(hsv[..., 2], 55)))
        not_lip = ~(((cr > 145) & (cb < 135) & (hsv[..., 1] > 55)) | (hsv[..., 0] < 8) | (hsv[..., 0] > 168))
        not_shadow = hsv[..., 2] > 70
        candidate = (mouth_ellipse & low_sat & bright & not_lip & not_shadow).astype(np.uint8)
        candidate = cv2.morphologyEx(candidate, cv2.MORPH_OPEN, np.ones((2, 2), dtype=np.uint8))
        num_labels, labels, stats, _ = cv2.connectedComponentsWithStats(candidate, 8)
        mask = np.zeros((height, width), dtype=np.float32)
        min_area = max(3, int(width * height * 0.01))
        for label in range(1, num_labels):
            area = stats[label, cv2.CC_STAT_AREA]
            x = stats[label, cv2.CC_STAT_LEFT]
            y = stats[label, cv2.CC_STAT_TOP]
            w = stats[label, cv2.CC_STAT_WIDTH]
            h = stats[label, cv2.CC_STAT_HEIGHT]
            if area < min_area or h > height * 0.75 or w < width * 0.05:
                continue
            mask[labels == label] = 1.0
        if mask.max() == 0:
            fallback = (mouth_ellipse & (hsv[..., 1] < 105) & (hsv[..., 2] > 105) & not_lip).astype(np.float32)
            mask = fallback
        if lips_mask is not None and lips_mask.shape[:2] == roi.shape[:2]:
            core_lips = cv2.erode((lips_mask > 0.12).astype(np.uint8), np.ones((3, 3), dtype=np.uint8), iterations=1).astype(np.float32)
            mask = np.clip(mask * np.maximum(core_lips, 0.0), 0.0, 1.0)
        if mask.max() > 0:
            mask = cv2.dilate(mask.astype(np.uint8), np.ones((2, 2), dtype=np.uint8), iterations=1).astype(np.float32)
            mask = cv2.GaussianBlur(mask, (0, 0), sigmaX=1.6, sigmaY=1.6)
        return np.clip(mask, 0.0, 1.0)

    @classmethod
    def _whiten_teeth(
        cls,
        image_u8: np.ndarray,
        faces: list,
        strength: float,
        context: dict[str, Any] | None = None,
    ) -> np.ndarray:
        result = image_u8.copy()
        mesh_results = context.get("mesh_results", []) if context is not None else _get_mediapipe_face_meshes(result)
        mesh_indices = context.get("mesh_indices", _get_face_mesh_index_sets()) if context is not None else _get_face_mesh_index_sets()
        for face in faces:
            x, y, w, h = face
            mouth_region = _detect_mouth_region(result, face, context=context)
            if mouth_region is not None:
                mx, my, mw, mh = mouth_region
                pad_x = max(2, int(mw * 0.16))
                pad_y = max(2, int(mh * 0.22))
                mx1 = max(0, mx - pad_x)
                mx2 = min(result.shape[1], mx + mw + pad_x)
                my1 = max(0, my - pad_y)
                my2 = min(result.shape[0], my + mh + pad_y)
            else:
                mx1 = max(0, x + int(w * 0.18))
                mx2 = min(result.shape[1], x + int(w * 0.82))
                my1 = max(0, y + int(h * 0.56))
                my2 = min(result.shape[0], y + int(h * 0.86))
            roi = result[my1:my2, mx1:mx2]
            if roi.size == 0:
                continue
            lips_mask = None
            mesh_match = _match_mediapipe_mesh(face, mesh_results)
            if mesh_match is not None:
                lips_mask = _landmark_region_mask_in_bbox(
                    mesh_match.get("landmarks"),
                    mesh_indices.get("lips", []),
                    (mx1, my1, mx2 - mx1, my2 - my1),
                )
            tooth_mask = cls._tooth_mask(roi, lips_mask=lips_mask)
            if tooth_mask.max() <= 0:
                continue
            lab = cv2.cvtColor(roi, cv2.COLOR_RGB2LAB).astype(np.float32)
            hsv = cv2.cvtColor(roi, cv2.COLOR_RGB2HSV).astype(np.float32)
            lab[..., 0] = np.clip(lab[..., 0] + tooth_mask * strength * 34.0, 0, 255)
            enhanced = cv2.cvtColor(lab.astype(np.uint8), cv2.COLOR_LAB2RGB).astype(np.float32)
            enhanced_hsv = cv2.cvtColor(enhanced.astype(np.uint8), cv2.COLOR_RGB2HSV).astype(np.float32)
            enhanced_hsv[..., 1] = np.clip(hsv[..., 1] * (1.0 - tooth_mask * strength * 0.52), 0, 255)
            enhanced = cv2.cvtColor(enhanced_hsv.astype(np.uint8), cv2.COLOR_HSV2RGB)
            alpha = np.clip(tooth_mask * (0.25 + strength * 0.65), 0.0, 0.88)
            result[my1:my2, mx1:mx2] = np.clip(roi.astype(np.float32) * (1.0 - alpha[..., None]) + enhanced.astype(np.float32) * alpha[..., None], 0, 255).astype(np.uint8)
        return result





    @staticmethod
    def _slim_faces(
        image_u8: np.ndarray,
        faces: list,
        strength: float,
        context: dict[str, Any] | None = None,
    ) -> np.ndarray:
        height, width = image_u8.shape[:2]
        base_x, base_y = np.meshgrid(np.arange(width, dtype=np.float32), np.arange(height, dtype=np.float32))
        map_x = base_x.copy()
        map_y = base_y.copy()
        strength = max(0.0, min(float(strength), 1.0))
        mesh_results = context.get("mesh_results", []) if context is not None else _get_mediapipe_face_meshes(image_u8)
        mesh_indices = context.get("mesh_indices", _get_face_mesh_index_sets()) if context is not None else _get_face_mesh_index_sets()
        for x, y, w, h in faces:
            mesh_match = _match_mediapipe_mesh((x, y, w, h), mesh_results)
            if mesh_match is not None:
                landmarks = mesh_match.get("landmarks")
                oval_points = _landmark_points(landmarks, mesh_indices.get("oval", []))
                if len(oval_points) >= 8:
                    face_center_x = float(np.mean(oval_points[:, 0]))
                    lower_points = oval_points[oval_points[:, 1] >= np.percentile(oval_points[:, 1], 42)]
                    if len(lower_points) >= 4:
                        for px, py in lower_points:
                            direction = -1.0 if px < face_center_x else 1.0
                            radius_x = max(6.0, w * 0.12)
                            radius_y = max(6.0, h * 0.16)
                            nx = (base_x - px) / radius_x
                            ny = (base_y - py) / radius_y
                            dist = np.clip(nx * nx + ny * ny, 0.0, 1.0)
                            weight = (1.0 - dist) ** 1.7
                            vertical_focus = np.clip((base_y - (y + h * 0.34)) / max(1.0, h * 0.58), 0.0, 1.0)
                            local_pull = direction * weight * vertical_focus * strength * w * 0.040
                            map_x = map_x - local_pull
                        continue
            cx = x + w / 2.0
            nx = (base_x - cx) / max(1.0, w * 0.5)
            ny = (base_y - (y + h * 0.60)) / max(1.0, h * 0.48)

            cheek_band = (np.abs(nx) > 0.34).astype(np.float32)
            cheek_band *= (np.abs(nx) < 1.05).astype(np.float32)
            vertical_band = np.exp(-(ny ** 2) * 1.8)
            jaw_weight = np.clip((base_y - (y + h * 0.34)) / max(1.0, h * 0.58), 0.0, 1.0)
            nose_protect = np.exp(-((base_x - cx) / max(1.0, w * 0.20)) ** 2 - ((base_y - (y + h * 0.52)) / max(1.0, h * 0.30)) ** 2)
            mouth_protect = np.exp(-((base_x - cx) / max(1.0, w * 0.26)) ** 2 - ((base_y - (y + h * 0.74)) / max(1.0, h * 0.16)) ** 2)
            eye_protect = np.exp(-((base_x - cx) / max(1.0, w * 0.42)) ** 2 - ((base_y - (y + h * 0.38)) / max(1.0, h * 0.18)) ** 2)
            protect = np.clip(nose_protect * 0.95 + mouth_protect * 0.85 + eye_protect * 0.75, 0.0, 1.0)

            weight = cheek_band * vertical_band * jaw_weight * (1.0 - protect)
            weight = cv2.GaussianBlur(weight.astype(np.float32), (0, 0), sigmaX=max(2.0, w * 0.025), sigmaY=max(2.0, h * 0.025))
            direction = np.sign(base_x - cx)
            inward_pull = direction * weight * strength * w * 0.055
            map_x = map_x + inward_pull

        return cv2.remap(image_u8, map_x, map_y, interpolation=cv2.INTER_LINEAR, borderMode=cv2.BORDER_REFLECT)


class GGImageStyleReference:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "目标图像": ("IMAGE",),
                "参考图像": ("IMAGE",),
            },
            "optional": {
                "风格强度": ("FLOAT", {"default": 0.35, "min": 0.0, "max": 2.0, "step": 0.05, "round": 0.01}),
                "色彩强度": ("FLOAT", {"default": 0.20, "min": 0.0, "max": 2.0, "step": 0.05, "round": 0.01}),
                "纹理强度": ("FLOAT", {"default": 0.0, "min": 0.0, "max": 1.0, "step": 0.05, "round": 0.01}),
                "保留结构": ("FLOAT", {"default": 0.0, "min": 0.0, "max": 1.0, "step": 0.05, "round": 0.01}),
            }
        }

    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("图像",)
    FUNCTION = "apply_style"
    CATEGORY = "GuliNodes/图像工具"

    def apply_style(self, 目标图像: torch.Tensor, 参考图像: torch.Tensor, 风格强度: float = 1.0,
                    色彩强度: float = 1.0, 纹理强度: float = 0.35, 保留结构: float = 0.35) -> tuple:
        content = _to_rgb_image(目标图像)
        style = _match_image_size(content, _to_rgb_image(参考图像))

        style_strength = max(0.0, min(float(风格强度), 2.0))
        color_strength = max(0.0, min(float(色彩强度), 2.0))
        texture_strength = max(0.0, min(float(纹理强度), 1.0))
        preserve_structure = max(0.0, min(float(保留结构), 1.0))

        color_transferred = _lab_color_transfer(content, style)
        stats_transferred = _adain_transfer(content, style)
        styled = content.lerp(color_transferred, min(color_strength, 1.0))
        if color_strength > 1.0:
            styled = styled + (color_transferred - content) * (color_strength - 1.0)

        styled = styled.lerp(stats_transferred, min(style_strength, 1.0))
        if style_strength > 1.0:
            styled = styled + (stats_transferred - content) * (style_strength - 1.0)

        style_low = _gaussian_blur(style, sigma=2.0)
        style_detail = style - style_low
        styled = styled + style_detail * texture_strength

        if preserve_structure > 0:
            content_low = _gaussian_blur(content, sigma=1.5)
            styled_low = _gaussian_blur(styled, sigma=1.5)
            content_detail = content - content_low
            styled = styled - (styled - styled_low) * preserve_structure + content_detail * preserve_structure

        return (torch.clamp(styled, 0.0, 1.0).contiguous(),)


class GGPreviewImage(PreviewImage):
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "图像": ("IMAGE",),
            },
            "hidden": {
                "prompt": "PROMPT",
                "extra_pnginfo": "EXTRA_PNGINFO",
            },
        }

    FUNCTION = "preview"
    CATEGORY = "GuliNodes/图像工具"

    def preview(self, 图像, prompt=None, extra_pnginfo=None):
        return self.save_images(图像, filename_prefix="GG.preview", prompt=prompt, extra_pnginfo=extra_pnginfo)


_GG_RECOMMENDED_FORMAT_ATTR = "_gg_recommended_format"
_GG_COMPRESSION_METHOD_ATTR = "_gg_compression_method"
_GG_COMPRESSION_QUALITY_ATTR = "_gg_compression_quality"
_GG_TARGET_SIZE_ATTR = "_gg_target_size_kb"
_GG_SUPPORTED_SAVE_FORMATS = {"JPEG", "PNG", "WEBP"}


def _coerce_gg_format(format_name: Any) -> str | None:
    if format_name is None:
        return None
    value = str(format_name).strip()
    if not value or value == "自动":
        return None
    value = value.upper()
    if value == "JPG":
        value = "JPEG"
    return value if value in _GG_SUPPORTED_SAVE_FORMATS else None


def _normalize_gg_format(format_name: Any, default: str = "JPEG", allow_auto: bool = False) -> str:
    value = str(format_name or "").strip()
    if allow_auto and (value == "自动" or value.upper() == "AUTO"):
        return "AUTO"
    return _coerce_gg_format(value) or default


def _set_gg_image_hints(
    images: torch.Tensor,
    format_name: str,
    quality: int,
    target_size_kb: int,
    method: str,
) -> None:
    try:
        setattr(images, _GG_RECOMMENDED_FORMAT_ATTR, format_name)
        setattr(images, _GG_COMPRESSION_QUALITY_ATTR, int(quality))
        setattr(images, _GG_TARGET_SIZE_ATTR, int(target_size_kb))
        setattr(images, _GG_COMPRESSION_METHOD_ATTR, method)
    except Exception:
        pass


def _get_gg_recommended_format(images: torch.Tensor) -> str | None:
    return _coerce_gg_format(getattr(images, _GG_RECOMMENDED_FORMAT_ATTR, None))


def _get_gg_int_hint(images: torch.Tensor, attr_name: str, default: int) -> int:
    try:
        return int(getattr(images, attr_name, default))
    except Exception:
        return default


def _tensor_image_to_pil(image: torch.Tensor) -> Image.Image:
    array = np.clip(255.0 * image.detach().cpu().numpy(), 0, 255).astype(np.uint8)
    if array.ndim == 2:
        return Image.fromarray(array, mode="L")

    channels = array.shape[-1] if array.ndim == 3 else 1
    if channels == 1:
        return Image.fromarray(array[..., 0], mode="L")
    if channels == 2:
        return Image.fromarray(array[..., :2], mode="LA")
    if channels == 3:
        return Image.fromarray(array[..., :3], mode="RGB")
    return Image.fromarray(array[..., :4], mode="RGBA")


def _prepare_pil_for_format(pil_image: Image.Image, format_name: str) -> Image.Image:
    if format_name == "JPEG":
        if pil_image.mode in ("RGBA", "LA") or (pil_image.mode == "P" and "transparency" in pil_image.info):
            rgba = pil_image.convert("RGBA")
            background = Image.new("RGBA", rgba.size, (255, 255, 255, 255))
            background.alpha_composite(rgba)
            return background.convert("RGB")
        return pil_image.convert("RGB")

    if format_name == "WEBP":
        if pil_image.mode in ("RGBA", "RGB"):
            return pil_image
        if pil_image.mode == "LA" or (pil_image.mode == "P" and "transparency" in pil_image.info):
            return pil_image.convert("RGBA")
        return pil_image.convert("RGB")

    return pil_image


class GGSaveImage(SaveImage):
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "图像": ("IMAGE",),
                "文件名前缀": ("STRING", {"default": "%date:yyyy_MM_dd%/图像"}),
                "格式": (["JPEG", "PNG", "WEBP", "自动"], {"default": "自动"}),
            },
            "hidden": {
                "prompt": "PROMPT",
                "extra_pnginfo": "EXTRA_PNGINFO",
            },
        }

    FUNCTION = "save"
    CATEGORY = "GuliNodes/图像工具"
    OUTPUT_NODE = True

    def save(self, 图像, 文件名前缀="%date:yyyy_MM_dd%/图像", 格式="自动", prompt=None, extra_pnginfo=None):
        resolved_prefix = _resolve_output_prefix(文件名前缀) + self.prefix_append
        full_output_folder, filename, counter, subfolder, _ = folder_paths.get_save_image_path(
            resolved_prefix,
            self.output_dir,
            图像[0].shape[1],
            图像[0].shape[0],
        )

        quality = max(1, min(_get_gg_int_hint(图像, _GG_COMPRESSION_QUALITY_ATTR, 95), 100))
        target_size_kb = max(0, _get_gg_int_hint(图像, _GG_TARGET_SIZE_ATTR, 0))
        requested_format = _normalize_gg_format(格式, default="AUTO", allow_auto=True)
        results = []

        for batch_number, image in enumerate(图像):
            format_name = self._select_format(图像, image, requested_format)
            pil_image = _tensor_image_to_pil(image)
            filename_with_batch_num = filename.replace("%batch_num%", str(batch_number))
            file = f"{filename_with_batch_num}_{counter:05}_.{self._extension(format_name)}"
            output_path = os.path.join(full_output_folder, file)
            self._save_encoded_image(
                pil_image,
                output_path,
                format_name,
                quality,
                target_size_kb,
                prompt,
                extra_pnginfo,
            )
            results.append({
                "filename": file,
                "subfolder": subfolder,
                "type": self.type,
            })
            counter += 1

        return {"ui": {"images": results}}

    def _select_format(self, images: torch.Tensor, image: torch.Tensor, requested_format: str) -> str:
        if requested_format != "AUTO":
            return requested_format
        recommended_format = _get_gg_recommended_format(images)
        if recommended_format is not None:
            return recommended_format
        return self._choose_auto_format(image)

    @staticmethod
    def _choose_auto_format(image: torch.Tensor) -> str:
        if image.shape[-1] >= 4:
            alpha = image[..., 3]
            try:
                if bool(torch.any(alpha < 0.999).item()):
                    return "PNG"
            except Exception:
                return "PNG"

        try:
            cpu_image = (image.detach().cpu().clamp(0.0, 1.0) * 255.0).to(torch.uint8)
            colors = cpu_image.reshape(-1, cpu_image.shape[-1])[:, :3]
            if colors.shape[0] > 32768:
                step = max(1, colors.shape[0] // 32768)
                colors = colors[::step][:32768]
            if torch.unique(colors, dim=0).shape[0] <= 256:
                return "PNG"
        except Exception:
            pass

        return "JPEG"

    @staticmethod
    def _extension(format_name: str) -> str:
        return {"WEBP": "webp", "JPEG": "jpg", "PNG": "png"}.get(format_name, "jpg")

    @staticmethod
    def _png_metadata(prompt=None, extra_pnginfo=None) -> PngInfo | None:
        if args.disable_metadata:
            return None
        metadata = PngInfo()
        if prompt is not None:
            metadata.add_text("prompt", json.dumps(prompt))
        if extra_pnginfo is not None:
            for key in extra_pnginfo:
                metadata.add_text(key, json.dumps(extra_pnginfo[key]))
        return metadata

    def _save_encoded_image(
        self,
        pil_image: Image.Image,
        output_path: str,
        format_name: str,
        quality: int,
        target_size_kb: int = 0,
        prompt=None,
        extra_pnginfo=None,
    ) -> None:
        if target_size_kb > 0 and format_name in ("JPEG", "WEBP"):
            self._save_target_size(pil_image, output_path, format_name, quality, target_size_kb)
            return

        save_image = _prepare_pil_for_format(pil_image, format_name)
        if format_name == "PNG":
            save_image.save(
                output_path,
                format="PNG",
                pnginfo=self._png_metadata(prompt, extra_pnginfo),
                compress_level=self.compress_level,
            )
        elif format_name == "WEBP":
            save_image.save(output_path, format="WEBP", quality=quality, method=6, optimize=True)
        else:
            save_image.save(
                output_path,
                format="JPEG",
                quality=quality,
                optimize=True,
                progressive=True,
                subsampling=0 if quality >= 90 else "4:2:0",
            )

    def _save_target_size(
        self,
        pil_image: Image.Image,
        output_path: str,
        format_name: str,
        quality: int,
        target_size_kb: int,
    ) -> None:
        target_bytes = max(1, int(target_size_kb)) * 1024

        def save_once(path: str, current_quality: int) -> None:
            self._save_encoded_image(pil_image, path, format_name, current_quality, 0)

        _save_target_size_by_quality(
            output_path,
            format_name,
            target_bytes,
            quality,
            save_once,
            iterations=8,
        )


def _save_target_size_by_quality(
    output_path: str,
    format_name: str,
    target_bytes: int,
    max_quality: int,
    save_once,
    iterations: int = 8,
) -> None:
    low, high = 1, max(1, min(int(max_quality), 100))
    best_data = None

    for _ in range(iterations):
        current_quality = (low + high) // 2
        with tempfile.NamedTemporaryFile(suffix="." + GGImageCompress._extension(format_name), delete=False) as temp_file:
            temp_path = temp_file.name
        try:
            save_once(temp_path, current_quality)
            size = os.path.getsize(temp_path)
            with open(temp_path, "rb") as handle:
                data = handle.read()
            if size <= target_bytes:
                best_data = data
                low = current_quality + 1
            else:
                high = current_quality - 1
        finally:
            if os.path.exists(temp_path):
                os.remove(temp_path)

    if best_data is None:
        save_once(output_path, 1)
        return
    with open(output_path, "wb") as handle:
        handle.write(best_data)


class GGImageCompress:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "图像": ("IMAGE",),
                "压缩方式": (["civilblur", "Caesium", "meowtec"], {"default": "civilblur"}),
                "质量": ("INT", {"default": 85, "min": 1, "max": 100, "step": 1}),
                "目标大小KB": ("INT", {"default": 0, "min": 0, "max": 1048576, "step": 16}),
            },
        }

    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("图像",)
    FUNCTION = "compress"
    CATEGORY = "GuliNodes/图像工具"
    OUTPUT_NODE = False

    def compress(self, 图像, 压缩方式="civilblur", 质量=85, 目标大小KB=0):
        return self._compress_with_method(图像, 压缩方式, 质量, 目标大小KB)

    def _compress_with_method(
        self,
        图像: torch.Tensor,
        压缩方式: str,
        质量: int = 85,
        目标大小KB: int = 0,
        preferred_format: str | None = None,
    ) -> tuple:
        method = self._normalize_method(压缩方式)
        quality = max(1, min(int(质量), 100))
        target_size_kb = max(0, int(目标大小KB))
        output_format = preferred_format or self._preferred_format(method, target_size_kb)
        output_images = []

        for image in 图像:
            pil_image = _prepare_pil_for_format(_tensor_image_to_pil(image), output_format)

            def save_callback(output_path: str, current_image=pil_image) -> None:
                self._save_by_method(
                    current_image,
                    output_path,
                    output_format,
                    quality,
                    target_size_kb,
                    method,
                )

            output_images.append(self._compress_with_tempfile(image, output_format, save_callback))

        image_result = torch.stack(output_images, dim=0).contiguous()
        _set_gg_image_hints(image_result, output_format, quality, target_size_kb, method)
        return (image_result,)

    @staticmethod
    def _normalize_method(method: str) -> str:
        value = str(method or "civilblur").strip().lower()
        if value in ("caesium", "cesium"):
            return "caesium"
        if value in ("meowtec", "meow"):
            return "meowtec"
        return "civilblur"

    @staticmethod
    def _preferred_format(method: str, target_size_kb: int) -> str:
        if method == "meowtec":
            return "WEBP"
        if method == "caesium" and target_size_kb > 0:
            return "WEBP"
        return "JPEG"

    @staticmethod
    def _extension(format_name: str) -> str:
        return {"WEBP": "webp", "JPEG": "jpg", "PNG": "png"}.get(format_name, "jpg")

    def _save_by_method(
        self,
        pil_image: Image.Image,
        output_path: str,
        format_name: str,
        quality: int,
        target_size_kb: int,
        method: str,
    ) -> None:
        if method == "caesium":
            self._save_caesium_style(pil_image, output_path, format_name, quality, target_size_kb)
        elif method == "meowtec":
            self._save_meowtec_style(pil_image, output_path, format_name, quality, target_size_kb)
        else:
            self._save_civilblur_style(pil_image, output_path, format_name, quality, target_size_kb)

    def _save_meowtec_style(
        self,
        pil_image: Image.Image,
        output_path: str,
        format_name: str,
        quality: int,
        target_size_kb: int,
    ) -> None:
        pil_image.info.clear()
        if target_size_kb > 0 and format_name in ("JPEG", "WEBP"):
            target_bytes = max(1, int(target_size_kb)) * 1024
            _save_target_size_by_quality(
                output_path,
                format_name,
                target_bytes,
                quality,
                lambda path, current_quality: self._save_meowtec_style(pil_image, path, format_name, current_quality, 0),
                iterations=7,
            )
            return
        self._save_single_pass(pil_image, output_path, format_name, quality)

    def _save_caesium_style(
        self,
        pil_image: Image.Image,
        output_path: str,
        format_name: str,
        quality: int,
        target_size_kb: int,
    ) -> None:
        pil_image.info.clear()
        if target_size_kb > 0 and format_name in ("JPEG", "WEBP"):
            target_bytes = max(1, int(target_size_kb)) * 1024
            _save_target_size_by_quality(
                output_path,
                format_name,
                target_bytes,
                quality,
                lambda path, current_quality: self._save_caesium_style(pil_image, path, format_name, current_quality, 0),
                iterations=7,
            )
            return

        if format_name == "JPEG":
            pil_image.convert("RGB").save(
                output_path,
                format="JPEG",
                quality=quality,
                optimize=True,
                progressive=True,
                subsampling=0 if quality >= 90 else "4:2:0",
            )
            return

        self._save_single_pass(pil_image, output_path, format_name, quality)

    def _save_civilblur_style(
        self,
        pil_image: Image.Image,
        output_path: str,
        format_name: str,
        quality: int,
        target_size_kb: int,
    ) -> None:
        pil_image.info.clear()
        if target_size_kb > 0 and format_name in ("WEBP", "JPEG"):
            target_bytes = max(1, int(target_size_kb)) * 1024
            _save_target_size_by_quality(
                output_path,
                format_name,
                target_bytes,
                quality,
                lambda path, current_quality: self._save_single_pass(pil_image, path, format_name, current_quality),
                iterations=8,
            )
            return

        self._save_single_pass(pil_image, output_path, format_name, quality)

    def _save_single_pass(self, pil_image: Image.Image, output_path: str, format_name: str, quality: int) -> None:
        save_image = _prepare_pil_for_format(pil_image, format_name)
        if format_name == "WEBP":
            save_image.save(output_path, format="WEBP", quality=quality, method=6, optimize=True)
        elif format_name == "PNG":
            save_image.save(output_path, format="PNG", optimize=True, compress_level=9)
        else:
            save_image.convert("RGB").save(
                output_path,
                format="JPEG",
                quality=quality,
                optimize=True,
                progressive=True,
                subsampling=0 if quality >= 90 else "4:2:0",
            )

    def _compress_with_tempfile(self, source_image: torch.Tensor, format_name: str, save_callback) -> torch.Tensor:
        suffix = "." + self._extension(format_name)
        with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as temp_file:
            temp_path = temp_file.name
        try:
            return self._compress_to_path(source_image, temp_path, save_callback)
        finally:
            if os.path.exists(temp_path):
                os.remove(temp_path)

    def _compress_to_path(self, source_image: torch.Tensor, output_path: str, save_callback) -> torch.Tensor:
        save_callback(output_path)
        with Image.open(output_path) as saved_image:
            return _pil_to_tensor(saved_image, device=source_image.device, dtype=source_image.dtype)


class ImageComparerBase:
    @classmethod
    def get_default_inputs(cls):
        return {
            "required": {},
            "optional": {
                "font_size": ("INT", {"default": 40, "min": 20, "max": 120, "step": 2}),
                "border": ("INT", {"default": 32, "min": 0, "max": 80, "step": 2}),
                "label_height": ("INT", {"default": 80, "min": 50, "max": 200, "step": 2}),
                "spacing": ("INT", {"default": 20, "min": 0, "max": 100, "step": 2}),
            }
        }

    @classmethod
    def create_image_inputs(cls, count: int) -> tuple:
        inputs = {}
        labels = {}
        for i in range(count):
            char = chr(65 + i)
            inputs[f"image_{char}"] = ("IMAGE",)
            labels[f"label_{char}"] = ("STRING", {"default": f"图像 {char}"})
        return inputs, labels


class GGImageComparer4(ImageComparerBase):
    @classmethod
    def INPUT_TYPES(s):
        inputs, labels = s.create_image_inputs(4)
        base_inputs = s.get_default_inputs()
        base_inputs["optional"].update(inputs)
        base_inputs["optional"].update(labels)
        return base_inputs

    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("对比结果",)
    FUNCTION = "compare"
    CATEGORY = "GuliNodes/图像工具"

    def compare(self, image_A: torch.Tensor = None, image_B: torch.Tensor = None, image_C: torch.Tensor = None, image_D: torch.Tensor = None,
                label_A: str = "图像 A", label_B: str = "图像 B", label_C: str = "图像 C", label_D: str = "图像 D",
                font_size: int = 40, border: int = 32, label_height: int = 80, spacing: int = 20, **kwargs) -> tuple:
        images = [img for img in [image_A, image_B, image_C, image_D] if img is not None]
        labels = [label_A, label_B, label_C, label_D][:len(images)]
        if len(images) < 2:
            return (image_A or image_B or image_C or image_D,)
        return (concatenate_images_horizontally(images, labels, font_size, border, label_height, spacing),)


class GGImageComparer2(PreviewImage):
    @classmethod
    def INPUT_TYPES(s):
        return {
            "required": {
                "image_A": ("IMAGE",),
                "image_B": ("IMAGE",),
            },
            "hidden": {
                "prompt": "PROMPT",
                "extra_pnginfo": "EXTRA_PNGINFO"
            }
        }

    FUNCTION = "compare"
    CATEGORY = "GuliNodes/图像工具"

    def compare(self, image_A: torch.Tensor, image_B: torch.Tensor,
                filename_prefix="GG.compare.",
                prompt=None, extra_pnginfo=None) -> dict:
        result = {"ui": {"a_images": [], "b_images": []}}
        if image_A is not None and len(image_A) > 0:
            result["ui"]["a_images"] = self.save_images(
                image_A, f"{filename_prefix}a_", prompt, extra_pnginfo
            )["ui"]["images"]
        if image_B is not None and len(image_B) > 0:
            result["ui"]["b_images"] = self.save_images(
                image_B, f"{filename_prefix}b_", prompt, extra_pnginfo
            )["ui"]["images"]
        return result


class GGImageComparer8(ImageComparerBase):
    @classmethod
    def INPUT_TYPES(s):
        inputs, labels = s.create_image_inputs(8)
        base_inputs = s.get_default_inputs()
        base_inputs["optional"].update(inputs)
        base_inputs["optional"].update(labels)
        return base_inputs

    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("对比结果",)
    FUNCTION = "compare"
    CATEGORY = "GuliNodes/图像工具"

    def compare(self, **kwargs) -> tuple:
        images = [kwargs.get(f"image_{chr(65 + i)}") for i in range(8)]
        images = [img for img in images if img is not None]
        labels = [kwargs.get(f"label_{chr(65 + i)}", f"图像 {chr(65 + i)}") for i in range(8)][:len(images)]
        font_size = kwargs.get("font_size", 40)
        border = kwargs.get("border", 32)
        label_height = kwargs.get("label_height", 80)
        spacing = kwargs.get("spacing", 20)
        if len(images) < 2:
            return (images[0] if images else None,)
        return (concatenate_images_horizontally(images, labels, font_size, border, label_height, spacing),)


NODE_CLASS_MAPPINGS = {
    "GGRGBAtoRGB": GGRGBAtoRGB,
    "GGImageResize": GGImageResize,
    "GGImageCrop": GGImageCrop,
    "GGImageTransform": GGImageTransform,
    "GGImageAdjust": GGImageAdjust,
    "GGFaceSkinSmoothing": GGFaceSkinSmoothing,
    "GGFaceSmartBeauty": GGFaceSmartBeauty,
    "GGImageStyleReference": GGImageStyleReference,
    "GGPreviewImage": GGPreviewImage,
    "GGSaveImage": GGSaveImage,
    "GGImageCompress": GGImageCompress,
    "GGImageComparer2": GGImageComparer2,
    "GGImageComparer4": GGImageComparer4,
    "GGImageComparer8": GGImageComparer8,
}


NODE_DISPLAY_NAME_MAPPINGS = {
    "GGRGBAtoRGB": "GG RGBA转RGB",
    "GGImageResize": "GG 图像调整大小",
    "GGImageCrop": "GG 图像裁剪",
    "GGImageTransform": "GG 图像变换",
    "GGImageAdjust": "GG 图像调整",
    "GGFaceSkinSmoothing": "GG 人脸磨皮",
    "GGFaceSmartBeauty": "GG 智能人脸美化",
    "GGImageStyleReference": "GG 图像风格参考",
    "GGPreviewImage": "GG 图像预览",
    "GGSaveImage": "GG 图像保存",
    "GGImageCompress": "GG 图像压缩",
    "GGImageComparer2": "GG 图像对比 2张",
    "GGImageComparer4": "GG 图像对比 4张",
    "GGImageComparer8": "GG 图像对比 8张",
}
