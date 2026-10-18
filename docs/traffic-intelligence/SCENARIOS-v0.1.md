# TI-01 — Synthetic JSON & Acceptance Scenarios v0.1

**Дата:** 2026-10-17. Всички стойности, пътища, доставчици, времена и източници по-долу са **СИНТЕТИЧНИ ПРИМЕРИ**, не реален feed, валидиран модел или резултат от изпълнен тест.

## 1. Примерни JSON request/response двойки

Двойките илюстрират логическия договор; не са API call traces. `null` е неизвестно, не нула. Всеки отговор echo-ва `requestId` и `routeRevision`. За компактност примерите са с един сегмент; при много сегменти се запазва входният ред. Полетата за provenance са синтетични.

### 1. Налични измервания

**Request**
```json
{
  "contractVersion": "0.1",
  "requestId": "syn-req-1",
  "routeRevision": "syn-route-r1",
  "departureAt": "2026-10-19T08:00:00Z",
  "vehicleProfileRef": "syn-truck-profile-A",
  "segments": [
    {
      "sequence": 0,
      "segmentRef": "syn-seg-001",
      "geometry": {
        "type": "LineString",
        "coordinates": [
          [
            23.31,
            42.69
          ],
          [
            23.32,
            42.7
          ]
        ]
      },
      "direction": "forward",
      "baseDurationSeconds": 300,
      "expectedEntryAt": "2026-10-19T08:30:00Z"
    }
  ],
  "evaluationCycle": "syn-cycle-1",
  "inputRevision": "syn-input-1-1",
  "attempt": 1
}
```

**Response**
```json
{
  "contractVersion": "0.1",
  "requestId": "syn-req-1",
  "routeRevision": "syn-route-r1",
  "evaluatedAt": "2026-10-19T08:28:00Z",
  "summaryStatus": "fresh",
  "segments": [
    {
      "sequence": 0,
      "segmentRef": "syn-seg-001",
      "status": "fresh",
      "matching": "matched",
      "matchConfidence": 0.99,
      "expectedEntryAt": "2026-10-19T08:30:00Z",
      "routingBase": {
        "kind": "routing_base",
        "durationSeconds": 300,
        "unit": "seconds",
        "source": {
          "sourceId": "routing-engine",
          "recordId": "syn-record-1",
          "recordVersion": "1",
          "licenseRef": "synthetic-only"
        },
        "candidateRef": "routingBase:syn-seg-001"
      },
      "measured": {
        "kind": "measured",
        "status": "fresh",
        "durationSeconds": 320,
        "unit": "seconds",
        "source": {
          "sourceId": "synthetic-live",
          "recordId": "syn-record-1",
          "recordVersion": "1",
          "licenseRef": "synthetic-only"
        },
        "observedAt": "2026-10-19T08:25:00Z",
        "publishedAt": "2026-10-19T08:26:00Z",
        "receivedAt": "2026-10-19T08:27:00Z",
        "validFrom": "2026-10-19T08:00:00Z",
        "validTo": "2026-10-19T09:00:00Z",
        "generatedAt": null,
        "horizonSeconds": null,
        "candidateRef": "measured:syn-seg-001"
      },
      "historical": {
        "kind": "historical",
        "status": "unavailable",
        "durationSeconds": null,
        "unit": "seconds",
        "source": {
          "sourceId": "synthetic-history",
          "recordId": "syn-record-1",
          "recordVersion": "1",
          "licenseRef": "synthetic-only"
        },
        "observedAt": null,
        "publishedAt": null,
        "receivedAt": null,
        "validFrom": null,
        "validTo": null,
        "generatedAt": null,
        "horizonSeconds": null,
        "candidateRef": "historical:syn-seg-001"
      },
      "forecast": {
        "kind": "forecast",
        "status": "unavailable",
        "durationSeconds": null,
        "unit": "seconds",
        "source": null,
        "observedAt": null,
        "publishedAt": null,
        "receivedAt": null,
        "validFrom": null,
        "validTo": null,
        "generatedAt": null,
        "horizonSeconds": null,
        "candidateRef": "forecast:syn-seg-001"
      },
      "incidents": [],
      "selected": {
        "kind": "measured",
        "status": "fresh",
        "durationSeconds": 320,
        "unit": "seconds",
        "source": {
          "sourceId": "synthetic-live",
          "recordId": "syn-record-1",
          "recordVersion": "1",
          "licenseRef": "synthetic-only"
        },
        "selectionReason": "representative_measurement",
        "candidateRef": "measured:syn-seg-001",
        "baseCandidateRef": null,
        "appliedEventRefs": []
      },
      "passability": "unknown",
      "vehicleApplicability": "covered",
      "provenance": [
        {
          "sourceId": "synthetic-live",
          "recordId": "syn-record-1",
          "recordVersion": "1",
          "licenseRef": "synthetic-only"
        }
      ]
    }
  ],
  "warnings": [],
  "evaluationCycle": "syn-cycle-1",
  "inputRevision": "syn-input-1-1",
  "attempt": 1
}
```

### 2. Само историческа оценка

**Request**
```json
{
  "contractVersion": "0.1",
  "requestId": "syn-req-2",
  "routeRevision": "syn-route-r1",
  "departureAt": "2026-10-19T08:00:00Z",
  "vehicleProfileRef": "syn-truck-profile-A",
  "segments": [
    {
      "sequence": 0,
      "segmentRef": "syn-seg-001",
      "geometry": {
        "type": "LineString",
        "coordinates": [
          [
            23.31,
            42.69
          ],
          [
            23.32,
            42.7
          ]
        ]
      },
      "direction": "forward",
      "baseDurationSeconds": 300,
      "expectedEntryAt": "2026-10-19T08:30:00Z"
    }
  ],
  "evaluationCycle": "syn-cycle-2",
  "inputRevision": "syn-input-2-1",
  "attempt": 1
}
```

**Response**
```json
{
  "contractVersion": "0.1",
  "requestId": "syn-req-2",
  "routeRevision": "syn-route-r1",
  "evaluatedAt": "2026-10-19T08:28:00Z",
  "summaryStatus": "fresh",
  "segments": [
    {
      "sequence": 0,
      "segmentRef": "syn-seg-001",
      "status": "fresh",
      "matching": "matched",
      "matchConfidence": 0.99,
      "expectedEntryAt": "2026-10-19T08:30:00Z",
      "routingBase": {
        "kind": "routing_base",
        "durationSeconds": 300,
        "unit": "seconds",
        "source": {
          "sourceId": "routing-engine",
          "recordId": "syn-record-2",
          "recordVersion": "1",
          "licenseRef": "synthetic-only"
        },
        "candidateRef": "routingBase:syn-seg-001"
      },
      "measured": {
        "kind": "measured",
        "status": "unavailable",
        "durationSeconds": null,
        "unit": "seconds",
        "source": {
          "sourceId": "synthetic-live",
          "recordId": "syn-record-2",
          "recordVersion": "1",
          "licenseRef": "synthetic-only"
        },
        "observedAt": null,
        "publishedAt": null,
        "receivedAt": null,
        "validFrom": null,
        "validTo": null,
        "generatedAt": null,
        "horizonSeconds": null,
        "candidateRef": "measured:syn-seg-001"
      },
      "historical": {
        "kind": "historical",
        "status": "fresh",
        "durationSeconds": 410,
        "unit": "seconds",
        "source": {
          "sourceId": "synthetic-history",
          "recordId": "syn-record-2",
          "recordVersion": "1",
          "licenseRef": "synthetic-only"
        },
        "observedAt": null,
        "publishedAt": "2026-10-19T08:26:00Z",
        "receivedAt": "2026-10-19T08:27:00Z",
        "validFrom": "2026-10-19T08:00:00Z",
        "validTo": "2026-10-19T09:00:00Z",
        "generatedAt": null,
        "horizonSeconds": null,
        "candidateRef": "historical:syn-seg-001"
      },
      "forecast": {
        "kind": "forecast",
        "status": "unavailable",
        "durationSeconds": null,
        "unit": "seconds",
        "source": null,
        "observedAt": null,
        "publishedAt": null,
        "receivedAt": null,
        "validFrom": null,
        "validTo": null,
        "generatedAt": null,
        "horizonSeconds": null,
        "candidateRef": "forecast:syn-seg-001"
      },
      "incidents": [],
      "selected": {
        "kind": "historical",
        "status": "fresh",
        "durationSeconds": 410,
        "unit": "seconds",
        "source": {
          "sourceId": "synthetic-history",
          "recordId": "syn-record-2",
          "recordVersion": "1",
          "licenseRef": "synthetic-only"
        },
        "selectionReason": "live_unavailable_or_stale",
        "candidateRef": "historical:syn-seg-001",
        "baseCandidateRef": null,
        "appliedEventRefs": []
      },
      "passability": "unknown",
      "vehicleApplicability": "covered",
      "provenance": [
        {
          "sourceId": "synthetic-history",
          "recordId": "syn-record-2",
          "recordVersion": "1",
          "licenseRef": "synthetic-only"
        }
      ]
    }
  ],
  "warnings": [
    "no_live_feed"
  ],
  "evaluationCycle": "syn-cycle-2",
  "inputRevision": "syn-input-2-1",
  "attempt": 1
}
```

### 3. Остарял източник

**Request**
```json
{
  "contractVersion": "0.1",
  "requestId": "syn-req-3",
  "routeRevision": "syn-route-r1",
  "departureAt": "2026-10-19T08:00:00Z",
  "vehicleProfileRef": "syn-truck-profile-A",
  "segments": [
    {
      "sequence": 0,
      "segmentRef": "syn-seg-001",
      "geometry": {
        "type": "LineString",
        "coordinates": [
          [
            23.31,
            42.69
          ],
          [
            23.32,
            42.7
          ]
        ]
      },
      "direction": "forward",
      "baseDurationSeconds": 300,
      "expectedEntryAt": "2026-10-19T08:30:00Z"
    }
  ],
  "evaluationCycle": "syn-cycle-3",
  "inputRevision": "syn-input-3-1",
  "attempt": 1
}
```

**Response**
```json
{
  "contractVersion": "0.1",
  "requestId": "syn-req-3",
  "routeRevision": "syn-route-r1",
  "evaluatedAt": "2026-10-19T08:28:00Z",
  "summaryStatus": "fresh",
  "segments": [
    {
      "sequence": 0,
      "segmentRef": "syn-seg-001",
      "status": "fresh",
      "matching": "matched",
      "matchConfidence": 0.99,
      "expectedEntryAt": "2026-10-19T08:30:00Z",
      "routingBase": {
        "kind": "routing_base",
        "durationSeconds": 300,
        "unit": "seconds",
        "source": {
          "sourceId": "routing-engine",
          "recordId": "syn-record-3",
          "recordVersion": "1",
          "licenseRef": "synthetic-only"
        },
        "candidateRef": "routingBase:syn-seg-001"
      },
      "measured": {
        "kind": "measured",
        "status": "stale",
        "durationSeconds": 350,
        "unit": "seconds",
        "source": {
          "sourceId": "synthetic-live",
          "recordId": "syn-record-3",
          "recordVersion": "1",
          "licenseRef": "synthetic-only"
        },
        "observedAt": "2026-10-19T08:25:00Z",
        "publishedAt": "2026-10-19T08:26:00Z",
        "receivedAt": "2026-10-19T08:27:00Z",
        "validFrom": "2026-10-19T08:00:00Z",
        "validTo": "2026-10-19T09:00:00Z",
        "generatedAt": null,
        "horizonSeconds": null,
        "candidateRef": "measured:syn-seg-001"
      },
      "historical": {
        "kind": "historical",
        "status": "fresh",
        "durationSeconds": 420,
        "unit": "seconds",
        "source": {
          "sourceId": "synthetic-history",
          "recordId": "syn-record-3",
          "recordVersion": "1",
          "licenseRef": "synthetic-only"
        },
        "observedAt": null,
        "publishedAt": "2026-10-19T08:26:00Z",
        "receivedAt": "2026-10-19T08:27:00Z",
        "validFrom": "2026-10-19T08:00:00Z",
        "validTo": "2026-10-19T09:00:00Z",
        "generatedAt": null,
        "horizonSeconds": null,
        "candidateRef": "historical:syn-seg-001"
      },
      "forecast": {
        "kind": "forecast",
        "status": "unavailable",
        "durationSeconds": null,
        "unit": "seconds",
        "source": null,
        "observedAt": null,
        "publishedAt": null,
        "receivedAt": null,
        "validFrom": null,
        "validTo": null,
        "generatedAt": null,
        "horizonSeconds": null,
        "candidateRef": "forecast:syn-seg-001"
      },
      "incidents": [],
      "selected": {
        "kind": "historical",
        "status": "fresh",
        "durationSeconds": 420,
        "unit": "seconds",
        "source": {
          "sourceId": "synthetic-history",
          "recordId": "syn-record-3",
          "recordVersion": "1",
          "licenseRef": "synthetic-only"
        },
        "selectionReason": "live_unavailable_or_stale",
        "candidateRef": "historical:syn-seg-001",
        "baseCandidateRef": null,
        "appliedEventRefs": []
      },
      "passability": "unknown",
      "vehicleApplicability": "covered",
      "provenance": [
        {
          "sourceId": "synthetic-history",
          "recordId": "syn-record-3",
          "recordVersion": "1",
          "licenseRef": "synthetic-only"
        }
      ]
    }
  ],
  "warnings": [
    "stale_measurement"
  ],
  "evaluationCycle": "syn-cycle-3",
  "inputRevision": "syn-input-3-1",
  "attempt": 1
}
```

### 4. Потвърдено затваряне

**Request**
```json
{
  "contractVersion": "0.1",
  "requestId": "syn-req-4",
  "routeRevision": "syn-route-r1",
  "departureAt": "2026-10-19T08:00:00Z",
  "vehicleProfileRef": "syn-truck-profile-A",
  "segments": [
    {
      "sequence": 0,
      "segmentRef": "syn-seg-001",
      "geometry": {
        "type": "LineString",
        "coordinates": [
          [
            23.31,
            42.69
          ],
          [
            23.32,
            42.7
          ]
        ]
      },
      "direction": "forward",
      "baseDurationSeconds": 300,
      "expectedEntryAt": "2026-10-19T08:30:00Z"
    }
  ],
  "evaluationCycle": "syn-cycle-4",
  "inputRevision": "syn-input-4-1",
  "attempt": 1
}
```

**Response**
```json
{
  "contractVersion": "0.1",
  "requestId": "syn-req-4",
  "routeRevision": "syn-route-r1",
  "evaluatedAt": "2026-10-19T08:28:00Z",
  "summaryStatus": "unavailable",
  "segments": [
    {
      "sequence": 0,
      "segmentRef": "syn-seg-001",
      "status": "unavailable",
      "matching": "matched",
      "matchConfidence": 0.99,
      "expectedEntryAt": "2026-10-19T08:30:00Z",
      "routingBase": {
        "kind": "routing_base",
        "durationSeconds": 300,
        "unit": "seconds",
        "source": {
          "sourceId": "routing-engine",
          "recordId": "syn-record-4",
          "recordVersion": "1",
          "licenseRef": "synthetic-only"
        },
        "candidateRef": "routingBase:syn-seg-001"
      },
      "measured": {
        "kind": "measured",
        "status": "fresh",
        "durationSeconds": 500,
        "unit": "seconds",
        "source": {
          "sourceId": "synthetic-live",
          "recordId": "syn-record-4",
          "recordVersion": "1",
          "licenseRef": "synthetic-only"
        },
        "observedAt": "2026-10-19T08:25:00Z",
        "publishedAt": "2026-10-19T08:26:00Z",
        "receivedAt": "2026-10-19T08:27:00Z",
        "validFrom": "2026-10-19T08:00:00Z",
        "validTo": "2026-10-19T09:00:00Z",
        "generatedAt": null,
        "horizonSeconds": null,
        "candidateRef": "measured:syn-seg-001"
      },
      "historical": {
        "kind": "historical",
        "status": "unavailable",
        "durationSeconds": null,
        "unit": "seconds",
        "source": {
          "sourceId": "synthetic-history",
          "recordId": "syn-record-4",
          "recordVersion": "1",
          "licenseRef": "synthetic-only"
        },
        "observedAt": null,
        "publishedAt": null,
        "receivedAt": null,
        "validFrom": null,
        "validTo": null,
        "generatedAt": null,
        "horizonSeconds": null,
        "candidateRef": "historical:syn-seg-001"
      },
      "forecast": {
        "kind": "forecast",
        "status": "unavailable",
        "durationSeconds": null,
        "unit": "seconds",
        "source": null,
        "observedAt": null,
        "publishedAt": null,
        "receivedAt": null,
        "validFrom": null,
        "validTo": null,
        "generatedAt": null,
        "horizonSeconds": null,
        "candidateRef": "forecast:syn-seg-001"
      },
      "incidents": [
        {
          "eventRef": "syn-closure-1",
          "eventVersion": "2",
          "lifecycle": "active",
          "effectKind": "none",
          "closure": "closed",
          "adjustmentSeconds": null,
          "alreadyIncludedIn": [],
          "source": {
            "sourceId": "synthetic-road-authority",
            "recordId": "syn-record-4",
            "recordVersion": "1",
            "licenseRef": "synthetic-only"
          },
          "validFrom": "2026-10-19T08:00:00Z",
          "validTo": "2026-10-19T10:00:00Z",
          "matchConfidence": 0.99,
          "baseCandidateRef": null,
          "replacementDurationSeconds": null,
          "independenceEvidenceRef": null
        }
      ],
      "selected": {
        "kind": "none",
        "status": "unavailable",
        "durationSeconds": null,
        "unit": "seconds",
        "source": null,
        "selectionReason": "closure_constraint",
        "candidateRef": null,
        "baseCandidateRef": null,
        "appliedEventRefs": []
      },
      "passability": "closed",
      "vehicleApplicability": "covered",
      "provenance": [
        {
          "sourceId": "synthetic-road-authority",
          "recordId": "syn-record-4",
          "recordVersion": "1",
          "licenseRef": "synthetic-only"
        }
      ]
    }
  ],
  "warnings": [
    "road_closed"
  ],
  "evaluationCycle": "syn-cycle-4",
  "inputRevision": "syn-input-4-1",
  "attempt": 1
}
```

### 5. Липсващи данни

**Request**
```json
{
  "contractVersion": "0.1",
  "requestId": "syn-req-5",
  "routeRevision": "syn-route-r1",
  "departureAt": "2026-10-19T08:00:00Z",
  "vehicleProfileRef": "syn-truck-profile-A",
  "segments": [
    {
      "sequence": 0,
      "segmentRef": "syn-seg-001",
      "geometry": {
        "type": "LineString",
        "coordinates": [
          [
            23.31,
            42.69
          ],
          [
            23.32,
            42.7
          ]
        ]
      },
      "direction": "forward",
      "baseDurationSeconds": 300,
      "expectedEntryAt": "2026-10-19T08:30:00Z"
    }
  ],
  "evaluationCycle": "syn-cycle-5",
  "inputRevision": "syn-input-5-1",
  "attempt": 1
}
```

**Response**
```json
{
  "contractVersion": "0.1",
  "requestId": "syn-req-5",
  "routeRevision": "syn-route-r1",
  "evaluatedAt": "2026-10-19T08:28:00Z",
  "summaryStatus": "unknown",
  "segments": [
    {
      "sequence": 0,
      "segmentRef": "syn-seg-001",
      "status": "unknown",
      "matching": "unmatched",
      "matchConfidence": null,
      "expectedEntryAt": "2026-10-19T08:30:00Z",
      "routingBase": {
        "kind": "routing_base",
        "durationSeconds": 300,
        "unit": "seconds",
        "source": {
          "sourceId": "routing-engine",
          "recordId": "syn-record-5",
          "recordVersion": "1",
          "licenseRef": "synthetic-only"
        },
        "candidateRef": "routingBase:syn-seg-001"
      },
      "measured": {
        "kind": "measured",
        "status": "unavailable",
        "durationSeconds": null,
        "unit": "seconds",
        "source": {
          "sourceId": "synthetic-live",
          "recordId": "syn-record-5",
          "recordVersion": "1",
          "licenseRef": "synthetic-only"
        },
        "observedAt": null,
        "publishedAt": null,
        "receivedAt": null,
        "validFrom": null,
        "validTo": null,
        "generatedAt": null,
        "horizonSeconds": null,
        "candidateRef": "measured:syn-seg-001"
      },
      "historical": {
        "kind": "historical",
        "status": "unavailable",
        "durationSeconds": null,
        "unit": "seconds",
        "source": {
          "sourceId": "synthetic-history",
          "recordId": "syn-record-5",
          "recordVersion": "1",
          "licenseRef": "synthetic-only"
        },
        "observedAt": null,
        "publishedAt": null,
        "receivedAt": null,
        "validFrom": null,
        "validTo": null,
        "generatedAt": null,
        "horizonSeconds": null,
        "candidateRef": "historical:syn-seg-001"
      },
      "forecast": {
        "kind": "forecast",
        "status": "unavailable",
        "durationSeconds": null,
        "unit": "seconds",
        "source": null,
        "observedAt": null,
        "publishedAt": null,
        "receivedAt": null,
        "validFrom": null,
        "validTo": null,
        "generatedAt": null,
        "horizonSeconds": null,
        "candidateRef": "forecast:syn-seg-001"
      },
      "incidents": [],
      "selected": {
        "kind": "routing_base",
        "status": "unknown",
        "durationSeconds": 300,
        "unit": "seconds",
        "source": {
          "sourceId": "routing-engine",
          "recordId": "syn-record-5",
          "recordVersion": "1",
          "licenseRef": "synthetic-only"
        },
        "selectionReason": "traffic_unavailable",
        "candidateRef": "routing_base:syn-seg-001",
        "baseCandidateRef": null,
        "appliedEventRefs": []
      },
      "passability": "unknown",
      "vehicleApplicability": "unknown",
      "provenance": [
        {
          "sourceId": "routing-engine",
          "recordId": "syn-record-5",
          "recordVersion": "1",
          "licenseRef": "synthetic-only"
        }
      ]
    }
  ],
  "warnings": [
    "no_traffic_coverage"
  ],
  "evaluationCycle": "syn-cycle-5",
  "inputRevision": "syn-input-5-1",
  "attempt": 1
}
```

### 6. Непокрита truck характеристика

**Request**
```json
{
  "contractVersion": "0.1",
  "requestId": "syn-req-6",
  "routeRevision": "syn-route-r1",
  "departureAt": "2026-10-19T08:00:00Z",
  "vehicleProfileRef": "syn-truck-profile-A",
  "segments": [
    {
      "sequence": 0,
      "segmentRef": "syn-seg-001",
      "geometry": {
        "type": "LineString",
        "coordinates": [
          [
            23.31,
            42.69
          ],
          [
            23.32,
            42.7
          ]
        ]
      },
      "direction": "forward",
      "baseDurationSeconds": 300,
      "expectedEntryAt": "2026-10-19T08:30:00Z"
    }
  ],
  "evaluationCycle": "syn-cycle-6",
  "inputRevision": "syn-input-6-1",
  "attempt": 1
}
```

**Response**
```json
{
  "contractVersion": "0.1",
  "requestId": "syn-req-6",
  "routeRevision": "syn-route-r1",
  "evaluatedAt": "2026-10-19T08:28:00Z",
  "summaryStatus": "unknown",
  "segments": [
    {
      "sequence": 0,
      "segmentRef": "syn-seg-001",
      "status": "unknown",
      "matching": "unmatched",
      "matchConfidence": null,
      "expectedEntryAt": "2026-10-19T08:30:00Z",
      "routingBase": {
        "kind": "routing_base",
        "durationSeconds": 300,
        "unit": "seconds",
        "source": {
          "sourceId": "routing-engine",
          "recordId": "syn-record-6",
          "recordVersion": "1",
          "licenseRef": "synthetic-only"
        },
        "candidateRef": "routingBase:syn-seg-001"
      },
      "measured": {
        "kind": "measured",
        "status": "unavailable",
        "durationSeconds": null,
        "unit": "seconds",
        "source": {
          "sourceId": "synthetic-live",
          "recordId": "syn-record-6",
          "recordVersion": "1",
          "licenseRef": "synthetic-only"
        },
        "observedAt": null,
        "publishedAt": null,
        "receivedAt": null,
        "validFrom": null,
        "validTo": null,
        "generatedAt": null,
        "horizonSeconds": null,
        "candidateRef": "measured:syn-seg-001"
      },
      "historical": {
        "kind": "historical",
        "status": "unavailable",
        "durationSeconds": null,
        "unit": "seconds",
        "source": {
          "sourceId": "synthetic-history",
          "recordId": "syn-record-6",
          "recordVersion": "1",
          "licenseRef": "synthetic-only"
        },
        "observedAt": null,
        "publishedAt": null,
        "receivedAt": null,
        "validFrom": null,
        "validTo": null,
        "generatedAt": null,
        "horizonSeconds": null,
        "candidateRef": "historical:syn-seg-001"
      },
      "forecast": {
        "kind": "forecast",
        "status": "unavailable",
        "durationSeconds": null,
        "unit": "seconds",
        "source": null,
        "observedAt": null,
        "publishedAt": null,
        "receivedAt": null,
        "validFrom": null,
        "validTo": null,
        "generatedAt": null,
        "horizonSeconds": null,
        "candidateRef": "forecast:syn-seg-001"
      },
      "incidents": [],
      "selected": {
        "kind": "routing_base",
        "status": "unknown",
        "durationSeconds": 300,
        "unit": "seconds",
        "source": {
          "sourceId": "routing-engine",
          "recordId": "syn-record-6",
          "recordVersion": "1",
          "licenseRef": "synthetic-only"
        },
        "selectionReason": "traffic_unavailable",
        "candidateRef": "routing_base:syn-seg-001",
        "baseCandidateRef": null,
        "appliedEventRefs": []
      },
      "passability": "unknown",
      "vehicleApplicability": "not_covered",
      "provenance": [
        {
          "sourceId": "routing-engine",
          "recordId": "syn-record-6",
          "recordVersion": "1",
          "licenseRef": "synthetic-only"
        }
      ]
    }
  ],
  "warnings": [
    "vehicle_profile_not_covered"
  ],
  "evaluationCycle": "syn-cycle-6",
  "inputRevision": "syn-input-6-1",
  "attempt": 1
}
```


## 1A. Допълнителни синтетични JSON примери (review)

### R1 — пълно replacement
```json
{
  "segmentRef": "s1",
  "measured": {
    "candidateRef": "measured:s1",
    "kind": "measured",
    "durationSeconds": 420,
    "source": {
      "sourceId": "synthetic-live",
      "recordId": "syn-measured-r1",
      "recordVersion": "1",
      "licenseRef": "synthetic-only"
    }
  },
  "incidents": [
    {
      "eventRef": "e1",
      "eventVersion": "1",
      "effectKind": "replacement",
      "closure": "unknown",
      "source": {
        "sourceId": "synthetic-incident",
        "recordId": "syn-event-e1",
        "recordVersion": "1",
        "licenseRef": "synthetic-only"
      },
      "baseCandidateRef": null,
      "replacementDurationSeconds": 510,
      "adjustmentSeconds": null,
      "alreadyIncludedIn": [],
      "independenceEvidenceRef": null
    }
  ],
  "selected": {
    "candidateRef": "replacement:e1:1",
    "baseCandidateRef": null,
    "appliedEventRefs": [
      "e1"
    ],
    "kind": "replacement",
    "status": "fresh",
    "durationSeconds": 510,
    "source": {
      "sourceId": "synthetic-derived",
      "recordId": "syn-derived-13",
      "recordVersion": "1",
      "licenseRef": "synthetic-only"
    },
    "selectionReason": "synthetic_review_case"
  },
  "passability": "unknown",
  "provenance": [
    {
      "candidateRef": "measured:s1",
      "sourceId": "synthetic-live",
      "recordId": "syn-measured-r1",
      "recordVersion": "1",
      "licenseRef": "synthetic-only"
    },
    {
      "eventRef": "e1",
      "eventVersion": "1",
      "effectKind": "replacement",
      "sourceId": "synthetic-incident",
      "recordId": "syn-event-e1",
      "recordVersion": "1",
      "licenseRef": "synthetic-only"
    }
  ]
}
```

### R2 — независим adjustment
```json
{
  "segmentRef": "s1",
  "measured": {
    "candidateRef": "measured:s1",
    "kind": "measured",
    "durationSeconds": 420,
    "source": {
      "sourceId": "synthetic-live",
      "recordId": "syn-measured-r1",
      "recordVersion": "1",
      "licenseRef": "synthetic-only"
    }
  },
  "incidents": [
    {
      "eventRef": "e1",
      "eventVersion": "1",
      "effectKind": "adjustment",
      "closure": "unknown",
      "source": {
        "sourceId": "synthetic-incident",
        "recordId": "syn-event-e1",
        "recordVersion": "1",
        "licenseRef": "synthetic-only"
      },
      "baseCandidateRef": "measured:s1",
      "replacementDurationSeconds": null,
      "adjustmentSeconds": 60,
      "alreadyIncludedIn": [],
      "independenceEvidenceRef": "synthetic-independent-evidence"
    }
  ],
  "selected": {
    "candidateRef": "derived:measured:s1:e1",
    "baseCandidateRef": "measured:s1",
    "appliedEventRefs": [
      "e1"
    ],
    "kind": "derived_adjustment",
    "status": "fresh",
    "durationSeconds": 480,
    "source": {
      "sourceId": "synthetic-derived",
      "recordId": "syn-derived-14",
      "recordVersion": "1",
      "licenseRef": "synthetic-only"
    },
    "selectionReason": "synthetic_review_case"
  },
  "passability": "unknown",
  "provenance": [
    {
      "candidateRef": "measured:s1",
      "sourceId": "synthetic-live",
      "recordId": "syn-measured-r1",
      "recordVersion": "1",
      "licenseRef": "synthetic-only"
    },
    {
      "eventRef": "e1",
      "eventVersion": "1",
      "effectKind": "adjustment",
      "sourceId": "synthetic-incident",
      "recordId": "syn-event-e1",
      "recordVersion": "1",
      "licenseRef": "synthetic-only"
    },
    {
      "independenceEvidenceRef": "synthetic-independent-evidence",
      "sourceId": "synthetic-evidence",
      "recordId": "syn-independent-e1",
      "recordVersion": "1",
      "licenseRef": "synthetic-only"
    }
  ]
}
```

### R3 — блокирано двойно броене
```json
{
  "segmentRef": "s1",
  "measured": {
    "candidateRef": "measured:s1",
    "kind": "measured",
    "durationSeconds": 420,
    "source": {
      "sourceId": "synthetic-live",
      "recordId": "syn-measured-r1",
      "recordVersion": "1",
      "licenseRef": "synthetic-only"
    }
  },
  "incidents": [
    {
      "eventRef": "e1",
      "eventVersion": "1",
      "effectKind": "adjustment",
      "closure": "unknown",
      "source": {
        "sourceId": "synthetic-incident",
        "recordId": "syn-event-e1",
        "recordVersion": "1",
        "licenseRef": "synthetic-only"
      },
      "baseCandidateRef": "measured:s1",
      "replacementDurationSeconds": null,
      "adjustmentSeconds": 120,
      "alreadyIncludedIn": [
        "measured:s1"
      ],
      "independenceEvidenceRef": null
    }
  ],
  "selected": {
    "candidateRef": "measured:s1",
    "baseCandidateRef": null,
    "appliedEventRefs": [],
    "kind": "measured",
    "status": "fresh",
    "durationSeconds": 420,
    "source": {
      "sourceId": "synthetic-live",
      "recordId": "syn-measured-r1",
      "recordVersion": "1",
      "licenseRef": "synthetic-only"
    },
    "selectionReason": "possible_double_count"
  },
  "passability": "unknown",
  "provenance": [
    {
      "candidateRef": "measured:s1",
      "sourceId": "synthetic-live",
      "recordId": "syn-measured-r1",
      "recordVersion": "1",
      "licenseRef": "synthetic-only"
    },
    {
      "eventRef": "e1",
      "eventVersion": "1",
      "effectKind": "adjustment",
      "status": "blocked",
      "reason": "possible_double_count",
      "sourceId": "synthetic-incident",
      "recordId": "syn-event-e1",
      "recordVersion": "1",
      "licenseRef": "synthetic-only"
    }
  ]
}
```

## 2. Детерминирани приемателни сценарии (спецификация, НЕ изпълнени тестове)

| ID | Вход / предусловие | Очакван резултат |
|---|---|---|
| A01 | Два източника описват едно и също +120 s закъснение, една посока и време | Един избран кандидат; не +240 s; запазени и двата provenance IDs |
| A02 | Инцидент на обратната посока със същите координати | Не се прилага към forward сегмента; `unmatched/unknown` при липса на друго доказателство |
| A03 | Incremental feed не съдържа вчерашно active closure | Затварянето остава active до explicit cancellation/expiry |
| A04 | Успешен full snapshot с ясно деклариран обхват пропуска старо closure от същия source | Closure се деактивира само в този source/scope, не при непълен snapshot |
| A05 | `cancelled` версия 3 на source event версия 2 | Версия 2 не е active; audit остава; чужд source event не се отменя |
| A06 | `corrected` версия 4 заменя версия 3 с нова геометрия | Прилага се версия 4; старият match се преизчислява; версия 3 е audit |
| A07 | `validTo=09:00Z`, `expectedEntryAt=09:01Z` | Ефектът е expired/неприложим; не се използва като fresh |
| A08 | Почивка 08:30–09:15Z преди сегмент; инцидент валиден до 09:00Z | Използва се `expectedEntryAt=09:15Z`; инцидентът не се прилага |
| A09 | DST fall-back: локално 02:30 се среща два пъти, но request е UTC | UTC е недвусмислен; без offset/IANA disambiguation локален вход се отхвърля |
| A10 | Отговор за `routeRevision=r1` пристига след заявка за `r2` | Отговорът r1 се отхвърля за текущата карта/ETA; няма overwrite |
| A11 | Feed има vehicle count, но няма speed/travel time | Не се извежда скорост/ETA от count; `measured.durationSeconds=null` |
| A12 | Active потвърдено затваряне за посоката/профила | `passability=closed`, `selected.durationSeconds=null`; planner решава за обход |
| A13 | Два източника противоречат за open/closed без разрешима приоритетност | `passability=unknown`, warning `conflicting_passability`; не се приема open |
| A14 | Измерено пълно време 420 s вече включва инцидент +120 s | `selected=420 s`, не 540 s; adjustment е блокиран като double count |
| A15 | Повторен `(sourceId,recordId,version)` със същия payload | Idempotent no-op; не се създава второ събитие |
| A16 | Същият source/version ключ, но различен payload | `version_collision`, карантина, без silent overwrite |
| A17 | Incident върху близък успореден път или пресичащ мост | Не се прехвърля по геометрична близост; `ambiguous/unmatched` |
| A18 | Truck height/weight constraint не е покрит от source | `vehicleApplicability=not_covered`, warning; не се твърди truck-safe route |
| A19 | Няма live feed, но има приложима historical оценка 410 s | `measured=unavailable`, `selected.kind=historical`, ясно означен fallback |
| A20 | Forecast endpoint връща число, но няма валидиран модел | `forecast=unavailable`, числото не се използва |
| A21 | 3 опита в един evaluationCycle дават 400→470→410 s без стабилизиране | Stop след третата; warning `unstable_estimate`; не се твърди конвергенция |
| A22 | Измерване `observedAt` старо, но `receivedAt` току-що | `stale`, не `fresh` само заради нов receive timestamp |
| A23 | Сегмент без `baseDurationSeconds` и без приложими traffic данни | `selected.durationSeconds=null`, status `unavailable/unknown`, никога 0 |
| A24 | Event в reverse carriageway на тунел със същия road name | Не се прилага на forward; road name сам не е достатъчен |

| A25 | Replacement 510 s и measured 420 s | Избира 510 s като пълно време, не сбор |
| A26 | Независим adjustment +60 s върху measured 420 s, с доказателство | Избира 480 s; baseCandidateRef и provenance са явни |
| A27 | Adjustment +120 s вече е в measured 420 s или няма evidence | Избира 420 s; warning possible_double_count |
| A28 | Нова departure/почивки при същата routeRevision | Нов evaluationCycle с нов лимит 3 опита |
| A29 | Закъснял отговор със стар inputRevision/attempt/requestId | Отхвърля се, дори routeRevision да съвпада |
| A30 | incidents=[] и measured 320 s без open evidence | passability=unknown |
| A31 | historical 410 s без потвърждение за проходимост | passability=unknown |
| A32 | open evidence е expired за expectedEntryAt | Не се приема open |

| A33 | closure=closed и effectKind=constraint | Невалиден enum; допустимо е effectKind=none без числов ефект |
| A34 | replacement е приложен, но incident липсва от provenance | Невалиден lineage; изисква се eventRef/source |
| A35 | adjustment е приложен, но evidence ref липсва от provenance | Невалиден lineage; изисква се evidence record |
| A36 | adjustment е блокиран без доказателство | Не се добавя измислено evidence; appliedEventRefs=[] |

## 3. Отворени проверки

- Нужни са реални provider sample payloads, документирани IDs/version/cancellation, snapshot semantics, direction/location reference, лиценз и timestamp semantics. До тогава всички са `unknown`.
- Трябва да се потвърди, че planner може да подава `expectedEntryAt` за всеки сегмент, включително почивките, без да се редактира `engine/plan.js` в TI-01.
- Трябва да се договори машинно проверима JSON Schema, статус кодове и contract tests в отделно възлагане.