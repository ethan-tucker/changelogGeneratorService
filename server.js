import express from 'express';
import cors from 'cors';
import { Octokit } from '@octokit/rest';
import OpenAI from 'openai';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { db } from './firebase.js';
import { collection, addDoc, getDocs, query, orderBy, limit, startAfter } from 'firebase/firestore';

// Configure dotenv
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
dotenv.config();

const app = express();
const allowedOrigins = [
    'http://localhost:3000',     // Local development
    process.env.FRONTEND_URL  // Your deployed frontend domain
  ];
  
  app.use(cors({
    origin: function(origin, callback) {
      // Allow requests with no origin (like mobile apps or curl requests)
      if (!origin) return callback(null, true);
      
      if (allowedOrigins.indexOf(origin) === -1) {
        const msg = 'The CORS policy for this site does not allow access from the specified Origin.';
        return callback(new Error(msg), false);
      }
      return callback(null, true);
    },
    credentials: true
  }));

// Initialize clients
const octokit = new Octokit({
    auth: process.env.MY_GITHUB_TOKEN
});

const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY
});

// Store ongoing changelog generation jobs
const changelogJobs = new Map();

// Configuration for GitHub repository
const REPO_OWNER = process.env.REPO_OWNER;
const REPO_NAME = process.env.REPO_NAME;

// Generate changelog using AI
async function generateChangelogFromCommits(commits) {
    try {
        // Transform commits into detailed descriptions
        const commitDetails = await Promise.all(commits.map(async (commit) => {
            const detailedCommit = await octokit.repos.getCommit({
                owner: REPO_OWNER,
                repo: REPO_NAME,
                ref: commit.sha
            });

            return {
                message: commit.message,
                link: `https://github.com/${REPO_OWNER}/${REPO_NAME}/commit/${commit.sha}`,
                stats: {
                    additions: detailedCommit.data.stats.additions,
                    deletions: detailedCommit.data.stats.deletions
                },
                files: detailedCommit.data.files.map(file => ({
                    patch: file.patch
                }))
            };
        }));

        const commitDescriptions = commitDetails.map(commit => {
            const fileChangeSummary = commit.files.map(file => {
                const patchPreview = file.patch ?
                    file.patch.split('\n').slice(0, 5).join('\n') +
                    (file.patch.split('\n').length > 5 ? '\n...' : '') :
                    '';

                return `
                    Preview of changes:
                    ${patchPreview}
                    `;
            }).join('\n');

            return `
                Commit Message: ${commit.message}
                Commit Link: ${commit.link}
                Modified Files:
                ${fileChangeSummary}
                `;
        }).join('\n---\n');

        const prompt = `Given these detailed git commits, generate a user-friendly changelog.
Group changes into categories like "Features", "Bug Fixes", "Improvements", etc.
Summarize the changes that would be relevant to an end-user in a few (less than 10 TOTAL) bullet points.
Order the changes from first to last in order of importance.

Important guidelines:
- output a maximum of 10 total bullet points 
- Focus on changes that affect the user experience directly
- Exclude internal changes like version bumps, refactoring, or test updates
- Use clear, non-technical language
- Highlight new features, improvements, and bug fixes that users will notice
- Mention breaking changes or important updates that require user attention
- Keep descriptions concise but informative, don't just copy and paste the commit message
- Include the relevant commit link with each change

Format the response as JSON with the following structure:
{
    "changes": [
    {
        "category": "string",
        "items": [
            {
                "description": "string",
                "commitLink": "string"
            }
        ]
    }
    ]
}

Detailed Commit Information:
${commitDescriptions}`;

        const completion = await openai.chat.completions.create({
            model: "gpt-4-1106-preview",
            messages: [
                {
                    role: "system",
                    content: "You are a helpful assistant that generates clear, concise changelogs from git commits."
                },
                {
                    role: "user",
                    content: prompt
                }
            ],
            response_format: { type: "json_object" }
        });

        return JSON.parse(completion.choices[0].message.content);
    } catch (error) {
        console.error('Error generating changelog:', error);
        throw error;
    }
}

// Updated store changelog function to handle new format
async function storeChangelog(changelog, commits, version, title, startDate, endDate) {
    try {
        const mostRecentCommit = commits.reduce((latest, current) => {
            const currentDate = new Date(current.date);
            return !latest || currentDate > new Date(latest.date) ? current : latest;
        }, null);

        const changelogData = {
            timestampOfMostRecentCommit: mostRecentCommit.date,
            version: version || null,
            title: title || null,
            startDate: startDate,
            endDate: endDate,
            sections: changelog.changes.map(change => ({
                heading: change.category,
                bulletPoints: change.items.map(item => ({
                    bulletPointDetails: item.description,
                    linkToRelevantCommit: item.commitLink
                }))
            }))
        };

        const changelogsRef = collection(db, 'changelogs');
        const docRef = await addDoc(changelogsRef, changelogData);
        return docRef.id;
    } catch (error) {
        console.error('Error storing changelog:', error);
        throw error;
    }
}

// Helper function for async changelog generation
async function generateChangelogAsync(jobId, startDate, endDate, version, title) {
    try {
        // Fetch commits within date range
        const commits = await fetchCommitsInDateRange(startDate, endDate);

        // Generate changelog
        const changelog = await generateChangelogFromCommits(commits);

        // Store in Firebase
        const changelogId = await storeChangelog(changelog, commits, version, title, startDate, endDate);

        changelogJobs.set(jobId, {
            status: 'completed',
            completed: true,
            changelog: {
                id: changelogId,
                date: new Date(),
                version,
                title,
                changes: changelog.changes
            }
        });
    } catch (error) {
        console.error('Error in async changelog generation:', error);
        changelogJobs.set(jobId, {
            status: 'error',
            completed: true,
            error: 'Failed to generate changelog'
        });
    }
}

// Helper function to fetch commits within a date range
async function fetchCommitsInDateRange(startDate, endDate) {
    try {
        const response = await octokit.repos.listCommits({
            owner: REPO_OWNER,
            repo: REPO_NAME,
            since: new Date(startDate).toISOString(),
            until: new Date(endDate).toISOString(),
        });

        return response.data.map(commit => ({
            sha: commit.sha,
            message: commit.commit.message,
            author: commit.commit.author.name,
            date: commit.commit.author.date
        }));
    } catch (error) {
        console.error('Error fetching commits in date range:', error);
        throw error;
    }
}

// API Routes

// Get commits
app.get('/api/commits', async (req, res) => {
    try {
        const page = parseInt(req.query.page) || 0;
        const pageSize = parseInt(req.query.pageSize) || 10;
        const startDate = req.query.startDate;
        const endDate = req.query.endDate;

        // First get total count of commits in date range
        const totalResponse = await octokit.repos.listCommits({
            owner: REPO_OWNER,
            repo: REPO_NAME,
            since: startDate ? new Date(startDate).toISOString() : undefined,
            until: endDate ? new Date(endDate).toISOString() : undefined,
            per_page: 1,
            page: 1
        });

        // Calculate total commits from the last page number in the Link header
        const totalCommits = parseInt(totalResponse.headers['link']?.match(/page=(\d+)>; rel="last"/)?.[1]) || 1;

        // Then get the specific page of commits
        const response = await octokit.repos.listCommits({
            owner: REPO_OWNER,
            repo: REPO_NAME,
            since: startDate ? new Date(startDate).toISOString() : undefined,
            until: endDate ? new Date(endDate).toISOString() : undefined,
            per_page: pageSize,
            page: page + 1
        });

        const totalPages = Math.ceil(totalCommits / pageSize);
        const currentItemCount = (page + 1) * pageSize;

        const commits = {
            items: response.data.map(commit => ({
                sha: commit.sha,
                message: commit.commit.message,
                author: commit.commit.author.name,
                date: commit.commit.author.date,
                link: `https://github.com/${REPO_OWNER}/${REPO_NAME}/commit/${commit.sha}`
            })),
            totalPages,
            hasMore: currentItemCount < totalCommits
        };

        res.json(commits);
    } catch (error) {
        console.error('Error handling commits request:', error);
        res.status(500).json({ error: 'Failed to fetch commits' });
    }
});

// Get changelogs
app.get('/api/changelogs', async (req, res) => {
    try {
        const pageSize = parseInt(req.query.pageSize) || 10;
        const lastTimestamp = req.query.lastTimestamp;

        let changelogsQuery;
        if (lastTimestamp) {
            changelogsQuery = query(
                collection(db, 'changelogs'),
                orderBy('startDate', 'desc'),  // Changed to sort by startDate
                startAfter(new Date(lastTimestamp)),
                limit(pageSize)
            );
        } else {
            changelogsQuery = query(
                collection(db, 'changelogs'),
                orderBy('startDate', 'desc'),  // Changed to sort by startDate
                limit(pageSize)
            );
        }

        const snapshot = await getDocs(changelogsQuery);
        const changelogs = [];
        snapshot.forEach(doc => {
            changelogs.push({
                id: doc.id,
                ...doc.data()
            });
        });

        // Check if there are more results
        const hasMore = changelogs.length === pageSize;

        res.json({
            items: changelogs,
            hasMore,
            lastTimestamp: changelogs.length > 0 ?
                changelogs[changelogs.length - 1].startDate :  // Changed to use startDate
                null
        });
    } catch (error) {
        console.error('Error fetching changelogs:', error);
        res.status(500).json({ error: 'Failed to fetch changelogs' });
    }
});

// Start changelog generation
app.post('/api/changelogs', async (req, res) => {
    try {
        const { startDate, endDate, version, title } = req.body;
        const jobId = Date.now().toString();

        // Start async job
        changelogJobs.set(jobId, {
            status: 'processing',
            completed: false
        });

        // Process changelog generation asynchronously
        generateChangelogAsync(jobId, startDate, endDate, version, title);

        res.json({ id: jobId });
    } catch (error) {
        console.error('Error starting changelog generation:', error);
        res.status(500).json({ error: 'Failed to start changelog generation' });
    }
});

// Check changelog generation status
app.get('/api/changelogs/status/:id', (req, res) => {
    const jobId = req.params.id;
    const job = changelogJobs.get(jobId);

    if (!job) {
        return res.status(404).json({ error: 'Job not found' });
    }

    res.json(job);
});

// Start server
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});