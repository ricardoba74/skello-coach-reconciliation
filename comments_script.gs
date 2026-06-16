/**
 * SKELLO DASHBOARD — Google Apps Script for Comments
 *
 * DEPLOYMENT INSTRUCTIONS (one-time setup, ~5 minutes):
 *
 * 1. Open File 1 (Teams Google Sheet):
 *    https://docs.google.com/spreadsheets/d/1COqOZLAQNO437dPZgQpBWsgjreI-FJlbPDfdwHPeDcA
 *
 * 2. Go to: Extensions → Apps Script
 *
 * 3. Delete any existing code, paste this entire file, then Save (Ctrl+S).
 *
 * 4. Click "Deploy" → "New deployment"
 *    - Type: Web app
 *    - Execute as: Me
 *    - Who has access: Anyone
 *    → Click "Deploy", authorise when prompted.
 *
 * 5. Copy the Web App URL (looks like:
 *    https://script.google.com/macros/s/XXXXXXXXXX/exec)
 *
 * 6. In the dashboard: click ⚙ Comments (top right) → paste the URL → Save.
 *    (Only needs to be done once per device; or hardcode it in HARDCODED_GAS_URL
 *    inside index.html so no one on the team needs to configure anything.)
 */

var SPREADSHEET_ID = "1COqOZLAQNO437dPZgQpBWsgjreI-FJlbPDfdwHPeDcA";
var SHEET_NAME     = "Comments";

// ── GET — return all comments as JSON ─────────────────────────────────────────
function doGet() {
  var sheet = getSheet();
  var rows  = sheet.getDataRange().getValues();
  var out   = {};
  for (var i = 1; i < rows.length; i++) {
    if (rows[i][0]) out[rows[i][0]] = rows[i][1] || "";
  }
  return json(out);
}

// ── POST — save / update a single comment ─────────────────────────────────────
function doPost(e) {
  var team, comment;
  try {
    // form-encoded body (sent from the dashboard via no-cors)
    team    = e.parameter.team    || "";
    comment = e.parameter.comment || "";
  } catch(_) { return json({ok: false}); }

  if (!team) return json({ok: false, error: "missing team"});

  var sheet = getSheet();
  var rows  = sheet.getDataRange().getValues();
  for (var i = 1; i < rows.length; i++) {
    if (rows[i][0] === team) {
      sheet.getRange(i + 1, 2).setValue(comment);
      sheet.getRange(i + 1, 3).setValue(new Date().toISOString());
      return json({ok: true});
    }
  }
  // New entry
  sheet.appendRow([team, comment, new Date().toISOString()]);
  return json({ok: true});
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function getSheet() {
  var ss    = SpreadsheetApp.openById(SPREADSHEET_ID);
  var sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(SHEET_NAME);
    sheet.appendRow(["Team", "Comment", "Updated"]);
    sheet.setFrozenRows(1);
  }
  return sheet;
}

function json(data) {
  return ContentService
    .createTextOutput(JSON.stringify(data))
    .setMimeType(ContentService.MimeType.JSON);
}
