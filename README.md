# **MeetAI**
The main repository for the production level graduation project ( **FCAIH 2022** ) 

## **How to use git ?**

### **1. Clone the repo**
```bash
$ git clone https://github.com/AhmedGamal-Gemy/MeetAI.git
```

### **2. Set the up-stream to dev branch**
```bash
$ git branch --set-upstream-to=origin/dev   
```
### **3. Create Feature branch**
#### Create Feature branch and edit on your respective layer folder :
```bash
$ git checkout -b feature/AI_layer/transcription
```

### **4. Work on the feature**

### **5. Add and commit changes**
#### Add all changes :
```bash
$ git add *
```
#### Commit all changes :
```bash
$ git commit -m "The descriptive message for what happens in this commit"
```

#### Push the commits to the feature branch :
```bash
$ git push
```

### **6. Switch to dev branch**
 ```bash
$ git checkout dev
```

### **7. Merge the feature to dev**
 ```bash
$ git merge feature/AI_layer/transcription
```

### **8. MAKE SURE TO PULL WORK BEFORE PUSHING**
```bash 
git pull
```
> **Solve conflicts if any**

### **9. Push dev branch** 
```bash 
git push
```

> Switch to any branch and continue working then the same steps
---