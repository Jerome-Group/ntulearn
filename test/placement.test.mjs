import assert from "node:assert/strict";
import test from "node:test";
import { attachmentPlacement, placementsIn } from "../src/sync/placement.mjs";

const COURSE = [
  {
    id: "_1_1",
    parentId: null,
    position: 8,
    title: "Career Pathways Platform",
    contentHandler: "resource/x-bb-folder",
  },
  {
    id: "_2_1",
    parentId: "_1_1",
    position: 2,
    title: "Instruction Manual",
    contentHandler: "resource/x-bb-folder",
  },
  {
    id: "_3_1",
    parentId: "_2_1",
    position: 0,
    title: "ultraDocumentBody",
    contentHandler: "resource/x-bb-document",
  },
  {
    id: "_4_1",
    parentId: null,
    position: 0,
    title: "Syllabus",
    contentHandler: "resource/x-bb-document",
  },
];

test("places an item at the root of the destination", () => {
  const placement = placementsIn(COURSE).get("_4_1");
  assert.deepEqual(placement.segments, []);
  assert.equal(placement.trail, "");
});

test("names the folders an item sits under, in NTULearn's words and in the destination's", () => {
  const placement = placementsIn(COURSE).get("_3_1");
  assert.equal(placement.trail, "Career Pathways Platform › Instruction Manual");
  assert.deepEqual(placement.segments, ["09 Career Pathways Platform", "03 Instruction Manual"]);
});

// The folder a folder makes is the folder its own document goes in, so both come from one walk.
test("places a folder in the folder it makes", () => {
  const placement = placementsIn(COURSE).get("_2_1");
  assert.deepEqual(placement.segments, ["09 Career Pathways Platform", "03 Instruction Manual"]);
});

test("counts a Learning Module as a folder its children sit under", () => {
  const items = [
    {
      id: "_5_1",
      parentId: null,
      position: 0,
      title: "Week 1",
      contentHandler: "resource/x-bb-lesson",
      contentDetail: { "resource/x-bb-lesson": { isFolder: true } },
    },
    {
      id: "_6_1",
      parentId: "_5_1",
      position: 0,
      title: "Notes",
      contentHandler: "resource/x-bb-document",
    },
  ];
  assert.deepEqual(placementsIn(items).get("_6_1").segments, ["01 Week 1"]);
});

test("numbers an attachment by the item carrying it and reports the path it lands on", () => {
  const placements = placementsIn(COURSE);
  const at = attachmentPlacement(placements.get("_3_1"), COURSE[2], {
    fileName: "Career_Platform_User_Guide.pdf",
  });

  assert.equal(at.file, "Career_Platform_User_Guide.pdf");
  assert.equal(at.trail, "Career Pathways Platform › Instruction Manual");
  assert.deepEqual(at.segments, [
    "09 Career Pathways Platform",
    "03 Instruction Manual",
    "01 Career_Platform_User_Guide.pdf",
  ]);
  assert.equal(
    at.path,
    "09 Career Pathways Platform/03 Instruction Manual/01 Career_Platform_User_Guide.pdf",
  );
});

test("keeps a title that names a folder out of the path it would escape to", () => {
  const items = [
    {
      id: "_7_1",
      parentId: null,
      position: 0,
      title: "../elsewhere",
      contentHandler: "resource/x-bb-folder",
    },
    {
      id: "_8_1",
      parentId: "_7_1",
      position: 0,
      title: "Notes",
      contentHandler: "resource/x-bb-document",
    },
  ];
  assert.deepEqual(placementsIn(items).get("_8_1").segments, ["01 _elsewhere"]);
});
