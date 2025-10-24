# Structure des exports Google Takeout

## Format d'archive
Google Takeout exporte les photos dans une archive ZIP avec cette structure :

```
Takeout/
└── Google Photos/
    ├── Photos from 2023/
    │   ├── IMG_20230101_120000.jpg
    │   ├── IMG_20230101_120000.jpg.json
    │   ├── IMG_20230215_143000.jpg
    │   └── IMG_20230215_143000.jpg.json
    ├── Photos from 2024/
    │   ├── IMG_20240301_090000.jpg
    │   ├── IMG_20240301_090000.jpg.json
    │   └── VID_20240315_180000.mp4
    └── Albums/
        ├── Vacances 2023/
        │   ├── beach_photo.jpg
        │   ├── beach_photo.jpg.json
        │   └── sunset_video.mp4
        └── Mariage/
            ├── ceremony_001.jpg
            └── ceremony_001.jpg.json
```

## Structure des métadonnées JSON

Chaque photo/vidéo a un fichier JSON associé avec ces informations :

```json
{
  "title": "IMG_20230101_120000.jpg",
  "description": "Photo prise pendant les vacances",
  "imageViews": "142",
  "creationTime": {
    "timestamp": "1672574400",
    "formatted": "1 janv. 2023, 12:00:00 UTC"
  },
  "photoTakenTime": {
    "timestamp": "1672574400",
    "formatted": "1 janv. 2023, 12:00:00 UTC"
  },
  "geoData": {
    "latitude": 43.6044622,
    "longitude": 3.8767337,
    "altitude": 12.0,
    "latitudeSpan": 0.0,
    "longitudeSpan": 0.0
  },
  "geoDataExif": {
    "latitude": 43.6044622,
    "longitude": 3.8767337,
    "altitude": 12.0,
    "latitudeSpan": 0.0,
    "longitudeSpan": 0.0
  },
  "url": "https://photos.google.com/lr/photo/...",
  "googlePhotosOrigin": {
    "mobileUpload": {
      "deviceType": "ANDROID_PHONE"
    }
  }
}
```

## Points clés
1. **Un fichier JSON par média** avec toutes les métadonnées
2. **Organisation par année** dans "Photos from YYYY"
3. **Albums séparés** dans le dossier "Albums"
4. **Timestamps précis** de création et de prise de vue
5. **Données géographiques** si disponibles
6. **Informations techniques** (device, views, etc.)
