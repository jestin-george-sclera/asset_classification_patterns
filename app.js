let assetPatterns = [];
let equipmentPatterns = [];
let keyHashMap = {};

async function loadJSON(path) {
  try {
    const res = await fetch(path);
    if (!res.ok) throw new Error(`Failed to load ${path}: ${res.statusText}`);
    return await res.json();
  } catch (err) {
    console.error(`Error loading JSON: ${err.message}`);
    throw err;
  }
}

function normalizeText(text) {
  return text.toLowerCase().replace(/[^\w\s]/g, '').replace(/\s+/g, ' ').trim();
}

function tokenizeInput(inputStr) {
  const normalized = normalizeText(inputStr);
  return normalized.match(/\b\w+\b/g) || [];
}

function levenshteinDistance(a, b) {
  const matrix = Array(b.length + 1).fill().map(() => Array(a.length + 1).fill(0));
  for (let i = 0; i <= a.length; i++) matrix[0][i] = i;
  for (let j = 0; j <= b.length; j++) matrix[j][0] = j;
  for (let j = 1; j <= b.length; j++) {
    for (let i = 1; i <= a.length; i++) {
      const indicator = a[i - 1] === b[j - 1] ? 0 : 1;
      matrix[j][i] = Math.min(
        matrix[j][i - 1] + 1,
        matrix[j - 1][i] + 1,
        matrix[j - 1][i - 1] + indicator
      );
    }
  }
  return matrix[b.length][a.length];
}

function fuzzyMatch(token, pattern, threshold = 60) {
  const maxLen = Math.max(token.length, pattern.length);
  const distance = levenshteinDistance(token, pattern);
  const ratio = maxLen ? ((maxLen - distance) / maxLen) * 100 : 0;
  return ratio >= threshold ? ratio : 0;
}

function classifyAsset(inputStr, patterns, threshold = 60) {
  const tokens = tokenizeInput(inputStr);
  let bestScore = 0;
  let bestMatch = null;
  let debugLog = [];

  for (const entry of patterns) {
    const { systemType, assetType, patterns: patternList, requireMatchCount } = entry;
    let matchCount = 0;
    let totalScore = 0;
    let entryMaxScore = 0;
    const entryLog = { systemType, assetType, matches: [] };

    for (const patternInfo of patternList) {
      const patternText = patternInfo.text;
      const weight = patternInfo.weight;
      entryMaxScore += weight;
      const patternTokens = patternText.toLowerCase().split(/\s+/);

      for (const token of tokens) {
        for (const patternToken of patternTokens) {
          const matchRatio = fuzzyMatch(token, patternToken, threshold);
          if (matchRatio > 0) {
            totalScore += (matchRatio / 100) * weight;
            matchCount++;
            entryLog.matches.push({ pattern: patternText, token, matchRatio, weight });
            break;
          }
        }
      }
    }

    entryLog.totalScore = totalScore;
    entryLog.matchCount = matchCount;
    entryLog.maxPossibleScore = entryMaxScore;
    debugLog.push(entryLog);

    if (matchCount >= requireMatchCount && totalScore > bestScore) {
      bestScore = totalScore;
      bestMatch = { assetType, systemType, score: totalScore };
    }
  }

  console.log('Classification Debug:', debugLog);
  if (bestMatch) {
    bestMatch.score = (bestMatch.score / debugLog.find(log => log.assetType === bestMatch.assetType).maxPossibleScore) * 100;
  }

  return bestMatch;
}

async function hashKey(key) {
  const data = new TextEncoder().encode(key);
  const buffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(buffer).slice(0, 8));
  const shortHashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
  keyHashMap[shortHashHex] = key;
  return shortHashHex;
}

async function hashEquipmentKeys(obj) {
  const newObj = {};
  for (const key of Object.keys(obj)) {
    const hash = await hashKey(key);
    const value = obj[key];
    if (typeof value === 'object' && !Array.isArray(value)) {
      newObj[hash] = await hashEquipmentKeys(value);
    } else {
      newObj[hash] = value;
    }
  }
  return newObj;
}

async function findEquipmentDetails(inputStr, assetType, systemType, equipmentPatterns, threshold = 60) {
  const tokens = tokenizeInput(inputStr);
  let bestScore = 0;
  let bestEquipment = null;
  let debugLog = [];

  for (const entry of equipmentPatterns) {
    if (entry.systemType === systemType && entry.assetType === assetType) {
      for (const equip of entry.patterns) {
        const { equipmentId, pattern: patternList, requireMatchCount, equipmentDetails } = equip;
        let matchCount = 0;
        let totalScore = 0;
        let equipMaxScore = 0;

        for (const patternInfo of patternList) {
          const patternText = patternInfo.text;
          const weight = patternInfo.weight;
          equipMaxScore += weight;
          const patternTokens = patternText.toLowerCase().split(/\s+/);

          for (const token of tokens) {
            for (const patternToken of patternTokens) {
              const matchRatio = fuzzyMatch(token, patternToken, threshold);
              if (matchRatio > 0) {
                totalScore += (matchRatio / 100) * weight;
                matchCount++;
                break;
              }
            }
          }
        }

        if (matchCount >= requireMatchCount && totalScore > bestScore) {
          bestScore = totalScore;
          const details = {
            manufacturer: equipmentDetails.manufacturer,
            model: equipmentDetails.model,
            productType: equipmentDetails.equipmentDetails.productType,
            features: equipmentDetails.equipmentDetails.features,
            technicalSpecs: equipmentDetails.equipmentDetails.technicalSpecs,
            application: equipmentDetails.equipmentDetails.application
          };
          const hashed = await hashEquipmentKeys(details);
          bestEquipment = { equipmentId, details: hashed, score: totalScore };
        }
      }
    }
  }

  if (bestEquipment) {
    bestEquipment.score = bestScore; // already max
  }

  return bestEquipment;
}

async function processImage() {
  const fileInput = document.getElementById('imageInput');
  const resultBox = document.getElementById('result');

  if (!fileInput.files.length) {
    resultBox.textContent = 'Please upload an image.';
    return;
  }

  const formData = new FormData();
  formData.append('image', fileInput.files[0]);
  resultBox.innerHTML = '<div class="text-gray-600">Uploading and extracting text...</div>';

  try {
    const response = await fetch('https://qa-app.sclera.com:2001/api/image-text', {
      method: 'POST',
      body: formData
    });

    const json = await response.json();
    if (!json.success || !json.data) {
      resultBox.innerHTML = '<div class="text-red-600">Failed to extract text from image.</div>';
      return;
    }

    const extractedText = json.data.join(' ');
    const assetResult = classifyAsset(extractedText, assetPatterns, 60);

    if (!assetResult) {
      resultBox.innerHTML = '<div class="text-red-600">No matching asset type found.</div>';
      return;
    }

    const { assetType, systemType, score } = assetResult;
    const equipmentResult = await findEquipmentDetails(extractedText, assetType, systemType, equipmentPatterns, 60);

    // Construct the JSON output object
    const outputJson = {
      classificationResult: {
        extractedText: extractedText,
        systemType: systemType,
        assetType: assetType,
        // Already normalized as a percentage in classifyAsset
      }
    };

    if (equipmentResult) {
      outputJson.equipmentDetails = {
        equipmentId: equipmentResult.equipmentId,
        // Raw score from findEquipmentDetails
        hashedEquipmentDetails: equipmentResult.details // Already a hashed JSON object
      };
    } else {
      outputJson.equipmentDetails = null;
      outputJson.message = 'No matching equipment details found.';
    }

    // Display the JSON output in the UI
    const output = `
      <div class="text-gray-600">
        <h2 class="text-lg font-semibold mb-2">Result (JSON Format)</h2>
        <pre class="bg-gray-100 p-4 rounded-lg overflow-auto">${JSON.stringify(outputJson, null, 2)}</pre>
      </div>
    `;
    resultBox.innerHTML = output;
    console.log('Key Hash Map:', keyHashMap);

  } catch (err) {
    resultBox.innerHTML = `<div class="text-red-600">Error: ${err.message}</div>`;
  }
}

// Load patterns and bootstrap
(async () => {
  try {
    assetPatterns = await loadJSON('asset_classification_patterns.json');
    equipmentPatterns = await loadJSON('model_man_pattern.json');
    console.log('Patterns loaded successfully.');
  } catch (err) {
    document.getElementById('result').innerHTML = `<div class="text-red-600">Failed to load patterns: ${err.message}</div>`;
  }
})();
