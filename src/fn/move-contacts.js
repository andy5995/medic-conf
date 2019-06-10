const minimist = require('minimist');
const path = require('path');
const readline = require('readline-sync');

const fs = require('../lib/sync-fs');
const log = require('../lib/log');
const pouch = require('../lib/db');
const lineageManipulation = require('../lib/lineage-manipulation');
const lineageConstraints = require('../lib/lineage-constraints');

const { warn, trace, info, error } = log;

const HIERARCHY_ROOT = 'root';

module.exports = (projectDir, couchUrl, extraArgs) => {
  const args = parseExtraArgs(projectDir, extraArgs);
  const db = connectToDatabase(couchUrl);
  prepareDocumentDirectory(args);
  return updateLineagesAndStage(args, db);
};

const prettyPrintDocument = doc => `'${doc.name}' (${doc._id})`;
const updateLineagesAndStage = async (options, db) => {
  trace(`Fetching contact details for parent: ${options.parentId}`);
  const parentDoc = await fetchContact(db, options.parentId);

  const constraints = await lineageConstraints(db, parentDoc);
  const { contactDocs, contactIdsSortedByDepth } = await preprocessContacts(db, options.contactIds, constraints);

  let affectedContactCount = 0, affectedReportCount = 0;
  const replacementLineage = lineageManipulation.createLineageFromDoc(parentDoc);
  for (let contactId of contactIdsSortedByDepth) {
    const contactDoc = contactDocs[contactId];
    const descendantsAndSelf = await fetchDescendantsOf(db, contactId);
    
    // Check that primary contact is not removed from areas where they are required
    const invalidPrimaryContactDoc = await constraints.getPrimaryContactViolations(contactDoc, descendantsAndSelf);
    if (invalidPrimaryContactDoc) {
      throw Error(`Cannot remove contact ${prettyPrintDocument(invalidPrimaryContactDoc)} from the hierarchy for which he is a primary contact.`);
    }

    trace(`Considering lineage updates to ${descendantsAndSelf.length} descendant(s) of contact ${prettyPrintDocument(contactDoc)}.`);
    const updatedDescendants = replaceLineageInContacts(descendantsAndSelf, replacementLineage, contactId);
    
    const ancestors = await fetchAncestorsOf(db, contactDoc);
    trace(`Considering primary contact updates to ${ancestors.length} ancestor(s) of contact ${prettyPrintDocument(contactDoc)}.`);
    const updatedAncestors = replaceLineageInAncestors(descendantsAndSelf, ancestors);

    const reportsCreatedByDescendants = await fetchReportsCreatedBy(db, descendantsAndSelf.map(descendant => descendant._id));
    trace(`${reportsCreatedByDescendants.length} report(s) created by these affected contact(s) will update`);
    const updatedReports = replaceLineageInReports(reportsCreatedByDescendants, replacementLineage, contactId);
    
    [...updatedDescendants, ...updatedReports, ...updatedAncestors].forEach(updatedDoc => {
      lineageManipulation.minifyLineagesInDoc(updatedDoc);
      writeDocumentToDisk(options, updatedDoc);
    });

    affectedContactCount += updatedDescendants.length + updatedAncestors.length;
    affectedReportCount += updatedReports.length;

    info(`Staged updates to ${prettyPrintDocument(contactDoc)}. ${updatedDescendants.length} contact(s) and ${updatedReports.length} report(s).`);
  }

  info(`Staged changes to lineage information for ${affectedContactCount} contact(s) and ${affectedReportCount} report(s).`);
};

/*
Fetches all of the documents associated with the "contactIds" and confirms they exist.
Checks for any errors which this will create in the hierarchy (hierarchy schema, circular hierarchies)
Sorts the contact id by their "depth" in the hierarchy
*/
const preprocessContacts = async (db, contactIds, constraints) => {
  const contactDocs = await db.allDocs({
    keys: contactIds,
    include_docs: true,
  });

  const missingContactErrors = contactDocs.rows.filter(row => !row.doc).map(row => `Contact with id '${row.key}' could not be found.`);
  if (missingContactErrors.length > 0) {
    throw Error(missingContactErrors);
  }

  const contactDocsById = contactDocs.rows.reduce((agg, curr) => Object.assign(agg, { [curr.doc._id]: curr.doc }), {});
  Object.values(contactDocsById).forEach(doc => {
    const hierarchyError = constraints.getHierarchyErrors(doc);
    if (hierarchyError) {
      throw Error(`Hierarchy Constraints: ${hierarchyError}`);
    }
  });

  /*
  Given two documents which are at different levels of the hierarchy, the order in which they are processed should not result in different outputs
  Sort the given list of contacts by their "depth" in the hierarchy as contacts should be processed "from the top"
  */
  const contactDepth = id => contactDocsById[id] && lineageManipulation.pluckIdsFromLineage(contactDocsById[id].parent).length || 0;
  contactIds.sort((a, b) => contactDepth(a) - contactDepth(b));
  return {
    contactIdsSortedByDepth: contactIds,
    contactDocs: contactDocsById,
  };
};

const fetchContact = async (db, id) => {
  try {
    if (id === HIERARCHY_ROOT) {
      return undefined;
    }

    return await db.get(id);
  } catch (err) {
    if (err.name !== 'not_found') {
      throw err;
    }

    throw Error(`Contact with id '${id}' could not be found`);
  }
};

// Parses extraArgs and asserts if required parameters are not present
const parseExtraArgs = (projectDir, extraArgs = []) => {
  const args = minimist(extraArgs, { boolean: true });

  const contactIds = (args.contacts || args.contact || '')
    .split(',')
    .filter(id => id);

  if (contactIds.length === 0) {
    usage();
    throw Error('Action "move-contacts" is missing required list of contact_id to be moved');
  }

  if (!args.parent) {
    usage();
    throw Error('Action "move-contacts" is missing required parameter parent');
  }

  return {
    parentId: args.parent,
    contactIds,
    docDirectoryPath: path.resolve(projectDir, args.docDirectoryPath || 'json_docs'),
    force: !!args.force,
  };
};

const connectToDatabase = couchUrl => {
  if (!couchUrl) {
    throw ('Action "move-contacts" is missing the required couchUrl information');
  }
  return pouch(couchUrl);
};

const prepareDocumentDirectory = ({ docDirectoryPath, force }) => {
  if (!fs.exists(docDirectoryPath)) {
    fs.mkdir(docDirectoryPath);
  } else if (!force && fs.recurseFiles(docDirectoryPath).length > 0) {
    warn(`The document folder '${docDirectoryPath}' already contains files. It is recommended you start with a clean folder. Do you clear this folder and continue?`);
    if(readline.keyInYN()) {
      fs.deleteFilesInFolder(docDirectoryPath);
    } else {
      error('User failed to confirm action.');
      process.exit(-1);
    }
  }
};

const usage = () => {
  const bold = text => `\x1b[1m${text}\x1b[0m`;
  console.log(`
${bold('medic-conf\'s move-contacts action')}
When combined with 'upload-docs' this action effectively moves a contact from one place in the hierarchy to another.

${bold('USAGE')}
medic-conf --local move-contacts -- --contactIds=<id1>,<id2> --parent=<parent_id>

${bold('OPTIONS')}
--contactIds=<id1>,<id2>
  A comma delimited list of ids of ocntacts to be moved.

--parent=<parent_id>
  Specifies the ID of the new parent. Use '${HIERARCHY_ROOT}' to identify the top of the hierarchy (no parent).

--docDirectoryPath=<path to stage docs>
  Specifies the folder used to store the documents representing the changes in hierarchy.
`);
};

/*
Given a contact's id, obtain the documents of all descendant contacts
*/
const fetchDescendantsOf = async (db, contactId) => {
  const descendantDocs = await db.query('medic/contacts_by_depth', {
    key: [contactId],
    include_docs: true,
  });

  return descendantDocs.rows
    .map(row => row.doc)
    /* We should not move or update tombstone documents */
    .filter(doc => doc && doc.type !== 'tombstone');
};

const fetchReportsCreatedBy = async (db, contactIds) => {
  const reports = await db.query('medic-client/reports_by_freetext', {
    keys: contactIds.map(id => [`contact:${id}`]),
    include_docs: true,
  });

  return reports.rows.map(row => row.doc);
};

const fetchAncestorsOf = async (db, contactDoc) => {
  const ancestorIds = lineageManipulation.pluckIdsFromLineage(contactDoc.parent);
  const ancestors = await db.allDocs({
    keys: ancestorIds,
    include_docs: true,
  });

  const ancestorIdsNotFound = ancestors.rows.filter(ancestor => !ancestor.doc).map(ancestor => ancestor.key);
  if (ancestorIdsNotFound.length > 0) {
    throw Error(`Contact '${prettyPrintDocument(contactDoc)} has parent id(s) '${ancestorIdsNotFound.join(',')}' which could not be found.`);
  }

  return ancestors.rows.map(ancestor => ancestor.doc);
};

const writeDocumentToDisk = ({ docDirectoryPath, force }, doc) => {
  const destinationPath = path.join(docDirectoryPath, `${doc._id}.doc.json`);
  if (fs.exists(destinationPath)) {
    const method = force ? warn : msg => { throw Error(msg); };
    method(`File at ${destinationPath} already exists and is being re-written. This may overwrite previously staged changes.`);
  }

  trace(`Writing updated document to ${destinationPath}`);
  fs.writeJson(destinationPath, doc);
};

const replaceLineageInReports = (reportsCreatedByDescendants, replaceWith, startingFromIdInLineage) => reportsCreatedByDescendants.reduce((agg, doc) => {
  if (lineageManipulation.replaceLineage(doc, 'contact', replaceWith, startingFromIdInLineage)) {
    agg.push(doc);
  }
  return agg;
}, []);

const replaceLineageInContacts = (descendantsAndSelf, replacementLineage, contactId) => descendantsAndSelf.reduce((agg, doc) => {
  const startingFromIdInLineage = doc._id === contactId ? undefined : contactId;
  const parentWasUpdated = lineageManipulation.replaceLineage(doc, 'parent', replacementLineage, startingFromIdInLineage);
  const contactWasUpdated = lineageManipulation.replaceLineage(doc, 'contact', replacementLineage, contactId);
  if (parentWasUpdated || contactWasUpdated) {
    agg.push(doc);
  }
  return agg;
}, []);

const replaceLineageInAncestors = (descendantsAndSelf, ancestors) => ancestors.reduce((agg, ancestor) => {
  let result = agg;
  const primaryContact = descendantsAndSelf.find(descendant => ancestor.contact && descendant._id === ancestor.contact._id);
  if (primaryContact) {
    ancestor.contact = lineageManipulation.createLineageFromDoc(primaryContact);
    result = [ancestor, ...result];
  }

  return result;
}, []);
