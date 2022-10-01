## Contribution Guidelines
![Contributions Welcome](https://img.shields.io/badge/Contributions-Welcome-blue?style=for-the-badge)

### Never made an open source contribution before? Wondering how contributions work in our project? Here's a quick rundown!

### Take a look at the Existing Issues or create your own Issues!
- Wait for the Issue to be assigned to you after which you can start working on it.
- Fork the Repo and create a Branch for any Issue that you are working upon.
- Read the Code of Conduct
- Create a Pull Request which will be promptly reviewed and suggestions would be added to improve it.

## Fork this repository

* Fork this repository by clicking on the fork button on the top of this page.
This will create a copy of this repository in your account.

## Clone the repository

* Now clone the forked repository to your machine. Go to your GitHub account, open the forked repository, click on the code button and then click the _copy to clipboard_ icon.

Open a terminal and run the following git command:

```
git clone "url you just copied"
```

where "url you just copied" (without the quotation marks) is the url to this repository (your fork of this project). 

For example:

```
git clone https://github.com/user-name/PDF-Dark-Mode.git
```

where `user-name` is your GitHub username. Here you're copying the contents of the PDF-Dark-Mode repository on GitHub to your computer.

## Navigate to the project directory
* After cloning the project in your computer, navigate to the project file using the command below.
```
cd PDF-Dark-Mode
```

## Add a reference(remote) to the original repository

```
git remote add upstream https://github.com/PDF-Dark-Mode.git
```

* Check the remotes for this repository.

```
git remote -v
```

* Always take a pull from the upstream repository to your master branch to keep it at par with the main project(updated repository).

```
git pull upstream main
```

## Create a new branch

```
git checkout -b <your_branch_name>
```

* Perform your desired changes to the code base.

1. Check you changes.

```
git status
```

```
git diff
```

2. Stage your changes

```
git add . <\files_that_you_made_changes>
```

3. Commit your changes.

```
git commit -m "Relevant message"
```

4. Push the committed changes in your feature branch to your remote repo.

```
git push -u origin <your_branch_name>
```

5. To create a pull request, click on `compare and pull request.

6. Add an appropriate title and description to your PR explaining your changes.

7. Cick on Create pull request. 

## Setup the project in your Local Mahine:

### Download project from Github

- If you're a Windows user, first install [git](https://git-scm.com/). This tool helps you run git from the command line.

1. Open a new Terminal (Mac) or Command Prompt (Windows) window and use the following command to create a unique directory to do your work in:

```
mkdir <new-project-folder>
```

```
cd <new-project-folder>
```

2. Next, use this command to clone the app repository:

```
git clone https://github.com/user-name/PDF-Dark-Mode.git
```

3. Check Remote

```
git remote -v
```

4. Create a new branch for your assigned issue

```
git checkout -b <branch-name>
```

That's it we setup the project into our local machine. Now follow the same procedure for making a Pull Request.

* Congrats :exclamation: You have made a PR to the PDF-Dark-Mode :boom: . Wait for your submission to be accepted and your PR to be merged.


* Wait for the pull request to be reviewed by a maintainer. Make changes to the pull request if the reviewing maintainer recommends them.


* Celebrate  🥳  your success after your first pull request is merged!
