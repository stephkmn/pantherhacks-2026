"""
YOLO Integration Example for CleanSky AI
Replace the simulated detection in main.py with this code
"""

from ultralytics import YOLO
from PIL import Image
import io
import numpy as np

# Load YOLO model (download happens automatically first time)
# Options:
# - yolov8n.pt (nano - fastest, less accurate)
# - yolov8s.pt (small)
# - yolov8m.pt (medium)
# - yolov8l.pt (large - best accuracy, slower)
model = YOLO('yolov8n.pt')

# Or use a custom trash-trained model:
# model = YOLO('path/to/trash_detection_model.pt')

# Class mapping for trash detection
# If using custom model, update these to match your classes
TRASH_CLASSES = {
    0: 'plastic_bottle',
    1: 'glass_bottle', 
    2: 'aluminum_can',
    3: 'plastic_bag',
    4: 'food_wrapper',
    5: 'cardboard',
    6: 'paper',
    7: 'styrofoam'
}

async def detect_trash_yolo(file: UploadFile):
    """
    Real YOLO-based trash detection
    Replace the /api/detect-image endpoint with this
    """
    
    # Read uploaded image
    contents = await file.read()
    image = Image.open(io.BytesIO(contents))
    
    # Run YOLO inference
    results = model(image, conf=0.5)  # 0.5 = 50% confidence threshold
    
    detections = []
    total_confidence = 0
    
    for result in results:
        boxes = result.boxes
        
        for box in boxes:
            class_id = int(box.cls[0])
            confidence = float(box.conf[0])
            bbox = box.xyxy[0].tolist()  # [x1, y1, x2, y2]
            
            # Map class ID to trash type
            trash_type = TRASH_CLASSES.get(class_id, 'unknown')
            
            detection = {
                'class': trash_type,
                'confidence': round(confidence, 2),
                'bbox': bbox,
                'center': [
                    (bbox[0] + bbox[2]) / 2,
                    (bbox[1] + bbox[3]) / 2
                ]
            }
            
            detections.append(detection)
            total_confidence += confidence
    
    # Calculate average confidence
    avg_confidence = total_confidence / len(detections) if detections else 0
    
    return {
        'detections': detections,
        'total_objects': len(detections),
        'average_confidence': round(avg_confidence, 2),
        'image_size': list(image.size)
    }


def estimate_waste_from_detections(detections, image_area_sqm):
    """
    Estimate waste amount based on detected objects
    
    Args:
        detections: List of detection objects
        image_area_sqm: Actual area covered by drone image (in square meters)
    
    Returns:
        estimated_kg: Estimated waste in kilograms
    """
    
    # Average weight per object type (in kg)
    WEIGHT_ESTIMATES = {
        'plastic_bottle': 0.05,
        'glass_bottle': 0.3,
        'aluminum_can': 0.015,
        'plastic_bag': 0.008,
        'food_wrapper': 0.005,
        'cardboard': 0.1,
        'paper': 0.002,
        'styrofoam': 0.01
    }
    
    total_weight = 0
    
    for detection in detections:
        object_class = detection['class']
        weight = WEIGHT_ESTIMATES.get(object_class, 0.05)  # default 50g
        total_weight += weight
    
    return round(total_weight, 2)


def convert_detections_to_hotspot(detections, drone_lat, drone_lng, image_area_sqm):
    """
    Convert image detections to a trash hotspot
    
    Args:
        detections: YOLO detection results
        drone_lat: Latitude where image was taken
        drone_lng: Longitude where image was taken  
        image_area_sqm: Area covered by the image
    
    Returns:
        TrashHotspot object
    """
    
    if not detections:
        return None
    
    # Count objects by type
    waste_types = {}
    for det in detections:
        class_name = det['class']
        waste_types[class_name] = waste_types.get(class_name, 0) + 1
    
    # Determine severity based on object count
    total_objects = len(detections)
    if total_objects > 20:
        severity = "high"
    elif total_objects > 10:
        severity = "medium"
    else:
        severity = "low"
    
    # Estimate waste
    estimated_kg = estimate_waste_from_detections(detections, image_area_sqm)
    
    # Estimate cleanup time (5 min per 10 objects)
    cleanup_minutes = max(10, int(total_objects / 2))
    
    # Average confidence
    avg_confidence = sum(d['confidence'] for d in detections) / len(detections)
    
    return {
        'lat': drone_lat,
        'lng': drone_lng,
        'severity': severity,
        'waste_types': list(waste_types.keys()),
        'estimated_waste_kg': estimated_kg,
        'cleanup_time_minutes': cleanup_minutes,
        'confidence': round(avg_confidence, 2),
        'object_count': total_objects,
        'object_breakdown': waste_types
    }


# ============================================
# FULL IMPLEMENTATION IN FASTAPI
# ============================================

"""
Add this to your main.py:

from fastapi import FastAPI, UploadFile, File
from ultralytics import YOLO
import io
from PIL import Image

model = YOLO('yolov8n.pt')

@app.post("/api/detect-image-real")
async def detect_trash_real(
    file: UploadFile = File(...),
    drone_lat: float = 33.8366,
    drone_lng: float = -117.9143,
    image_area_sqm: float = 100.0
):
    '''
    Real computer vision trash detection endpoint
    
    Upload an image taken by a drone and get:
    - Detected objects with bounding boxes
    - Estimated waste amount
    - Severity classification
    - Cleanup time estimate
    '''
    
    # Read and process image
    contents = await file.read()
    image = Image.open(io.BytesIO(contents))
    
    # Run YOLO
    results = model(image, conf=0.5)
    
    detections = []
    for result in results:
        for box in result.boxes:
            detections.append({
                'class': model.names[int(box.cls[0])],
                'confidence': float(box.conf[0]),
                'bbox': box.xyxy[0].tolist()
            })
    
    # Convert to hotspot
    hotspot = convert_detections_to_hotspot(
        detections,
        drone_lat,
        drone_lng,
        image_area_sqm
    )
    
    return {
        'raw_detections': detections,
        'hotspot': hotspot,
        'image_analyzed': True
    }
"""


# ============================================
# BATCH PROCESSING FOR DRONE FLIGHT
# ============================================

def process_drone_flight_images(image_folder_path, flight_path_coords):
    """
    Process multiple images from a drone flight
    
    Args:
        image_folder_path: Path to folder with drone images
        flight_path_coords: List of (lat, lng) for each image location
    
    Returns:
        List of hotspots detected along flight path
    """
    import os
    from pathlib import Path
    
    image_files = sorted(Path(image_folder_path).glob('*.jpg'))
    hotspots = []
    
    for i, (image_path, coords) in enumerate(zip(image_files, flight_path_coords)):
        image = Image.open(image_path)
        results = model(image)
        
        detections = []
        for result in results:
            for box in result.boxes:
                detections.append({
                    'class': model.names[int(box.cls[0])],
                    'confidence': float(box.conf[0]),
                    'bbox': box.xyxy[0].tolist()
                })
        
        if detections:
            hotspot = convert_detections_to_hotspot(
                detections,
                coords[0],
                coords[1],
                100.0  # Assume 100 sqm per image
            )
            hotspot['image_file'] = str(image_path)
            hotspot['sequence_number'] = i
            hotspots.append(hotspot)
    
    return hotspots


# ============================================
# USING ROBOFLOW (EASIER ALTERNATIVE)
# ============================================

"""
If you don't want to run YOLO locally, use Roboflow's API:

pip install roboflow

from roboflow import Roboflow

rf = Roboflow(api_key="YOUR_API_KEY")
project = rf.workspace().project("trash-detection")
model = project.version(1).model

# Predict on image
result = model.predict("drone_image.jpg", confidence=50)

# Get detections
predictions = result.json()['predictions']

for pred in predictions:
    print(f"Found {pred['class']} with {pred['confidence']}% confidence")
"""


# ============================================
# TESTING
# ============================================

if __name__ == "__main__":
    # Test the detection
    print("Testing YOLO trash detection...")
    
    # Create a test image path
    test_image = "test_trash_image.jpg"
    
    if os.path.exists(test_image):
        image = Image.open(test_image)
        results = model(image)
        
        print(f"\nDetected {len(results[0].boxes)} objects:")
        for box in results[0].boxes:
            class_name = model.names[int(box.cls[0])]
            confidence = float(box.conf[0])
            print(f"  - {class_name}: {confidence:.2%}")
    else:
        print(f"Place a test image at {test_image} to test detection")